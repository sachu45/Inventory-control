import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditAction, ConfigVersion, Prisma } from '@prisma/client';
import type Redis from 'ioredis';
import { AuditService } from '../../modules/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS_CLIENT } from '../cache/redis.provider';
import { ConfigResolverService } from './config-resolver.service';
import {
  ConfigChange,
  ConfigIssue,
  ConfigValidationException,
  ConfigVersionConflictException,
  DraftRow,
  PublishedSnapshot,
  compileSnapshot,
  diffSnapshots,
  draftsFromSnapshot,
  latestVersionCacheKey,
} from './config-snapshot';

type Db = Prisma.TransactionClient | PrismaService;

export type ConfigPreview = {
  baseVersion: number;
  snapshot: PublishedSnapshot;
  issues: ConfigIssue[];
  changes: ConfigChange[];
};

export type PublishResult = { version: ConfigVersion; changes: ConfigChange[] };

const AUDITED_PATH_LIMIT = 50;

@Injectable()
export class ConfigPublishService {
  private readonly logger = new Logger(ConfigPublishService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Pick<Redis, 'del'>,
    private readonly resolver: ConfigResolverService,
  ) {}

  /** The live version: the highest `version` for the company, or null before the first publish. */
  activeVersion(companyId: string, db: Db = this.prisma): Promise<ConfigVersion | null> {
    return db.configVersion.findFirst({ where: { companyId }, orderBy: { version: 'desc' } });
  }

  /** Compiles the current drafts without writing anything. */
  async compileDraft(companyId: string): Promise<ConfigPreview> {
    const active = await this.activeVersion(companyId);
    const { snapshot, issues } = await this.compile(this.prisma, companyId, await this.loadDrafts(this.prisma, companyId), active);
    return { baseVersion: active?.version ?? 0, snapshot, issues, changes: diffSnapshots(snapshotOf(active), snapshot) };
  }

  async publish(args: {
    companyId: string;
    expectedBaseVersion: number;
    actorId: string;
    note?: string;
  }): Promise<PublishResult> {
    const result = await this.inPublishLock(args.companyId, args.expectedBaseVersion, async (tx, active) => {
      const { snapshot } = await this.compileOrThrow(tx, args.companyId, await this.loadDrafts(tx, args.companyId), active);
      const version = await tx.configVersion.create({
        data: {
          companyId: args.companyId,
          version: snapshot.version,
          schemaVersion: snapshot.schemaVersion,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          changeNote: args.note ?? null,
          publishedBy: args.actorId,
        },
      });
      return { version, changes: diffSnapshots(snapshotOf(active), snapshot) };
    });
    await this.afterCommit(args.companyId, args.actorId, args.expectedBaseVersion, result);
    return result;
  }

  /** Publishes a copy of `targetVersion` as a new version and resets the drafts to match it. */
  async rollback(args: {
    companyId: string;
    targetVersion: number;
    expectedBaseVersion: number;
    actorId: string;
    note?: string;
  }): Promise<PublishResult> {
    const result = await this.inPublishLock(args.companyId, args.expectedBaseVersion, async (tx, active) => {
      const target = await tx.configVersion.findUnique({
        where: { companyId_version: { companyId: args.companyId, version: args.targetVersion } },
      });
      if (!target) throw new NotFoundException(`Config version ${args.targetVersion} not found`);

      const drafts = draftsFromSnapshot(snapshotOf(target)!);
      const { snapshot } = await this.compileOrThrow(tx, args.companyId, drafts, active);
      const version = await tx.configVersion.create({
        data: {
          companyId: args.companyId,
          version: snapshot.version,
          schemaVersion: snapshot.schemaVersion,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          sourceVersion: target.version,
          changeNote: args.note ?? `Rollback to version ${target.version}`,
          publishedBy: args.actorId,
        },
      });

      await tx.tenantModuleConfig.deleteMany({ where: { companyId: args.companyId } });
      await tx.tenantModuleConfig.createMany({
        data: drafts.map((row) => ({
          companyId: args.companyId,
          shopId: row.shopId,
          moduleKey: row.moduleKey,
          enabled: row.enabled,
          config: row.config as Prisma.InputJsonValue,
          updatedBy: args.actorId,
        })),
      });
      return { version, changes: diffSnapshots(snapshotOf(active), snapshot) };
    });
    await this.afterCommit(args.companyId, args.actorId, args.expectedBaseVersion, result);
    return result;
  }

  /** Structural diff between two published versions; version 0 means registry defaults. */
  async diff(companyId: string, fromVersion: number, toVersion: number): Promise<ConfigChange[]> {
    const load = async (version: number) => {
      if (version === 0) return null;
      const row = await this.prisma.configVersion.findUnique({
        where: { companyId_version: { companyId, version } },
      });
      if (!row) throw new NotFoundException(`Config version ${version} not found`);
      return snapshotOf(row);
    };
    const [from, to] = await Promise.all([load(fromVersion), load(toVersion)]);
    return diffSnapshots(from, to ?? compileSnapshot([], new Set(), 0).snapshot);
  }

  /**
   * Serialises publishes per company with a transaction-scoped advisory lock, then
   * re-checks the base version so a publish built on a stale preview gets a 409.
   */
  private async inPublishLock<T>(
    companyId: string,
    expectedBaseVersion: number,
    work: (tx: Prisma.TransactionClient, active: ConfigVersion | null) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`config_publish:${companyId}`}, 0))`;
        const active = await this.activeVersion(companyId, tx);
        const activeVersion = active?.version ?? 0;
        if (activeVersion !== expectedBaseVersion) {
          throw new ConfigVersionConflictException(expectedBaseVersion, activeVersion);
        }
        return work(tx, active);
      });
    } catch (err) {
      // The unique (company_id, version) index is the backstop if the lock is ever bypassed.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const active = await this.activeVersion(companyId);
        throw new ConfigVersionConflictException(expectedBaseVersion, active?.version ?? 0);
      }
      throw err;
    }
  }

  private loadDrafts(db: Db, companyId: string): Promise<DraftRow[]> {
    return db.tenantModuleConfig.findMany({
      where: { companyId },
      select: { shopId: true, moduleKey: true, enabled: true, config: true },
    });
  }

  private async compile(db: Db, companyId: string, drafts: DraftRow[], active: ConfigVersion | null) {
    const shops = await db.shop.findMany({ where: { companyId }, select: { id: true } });
    return compileSnapshot(drafts, new Set(shops.map((s) => s.id)), (active?.version ?? 0) + 1);
  }

  private async compileOrThrow(db: Db, companyId: string, drafts: DraftRow[], active: ConfigVersion | null) {
    const compiled = await this.compile(db, companyId, drafts, active);
    if (compiled.issues.length) throw new ConfigValidationException(compiled.issues);
    return compiled;
  }

  private async afterCommit(companyId: string, actorId: string, baseVersion: number, result: PublishResult) {
    const { version, changes } = result;
    await this.audit.log({
      companyId,
      userId: actorId,
      action: AuditAction.UPDATE,
      entityType: 'ConfigVersion',
      entityId: version.id,
      oldValues: { version: baseVersion },
      newValues: {
        version: version.version,
        sourceVersion: version.sourceVersion,
        changeNote: version.changeNote,
        changeCount: changes.length,
        changedPaths: changes.slice(0, AUDITED_PATH_LIMIT).map((c) => c.path),
      },
    });
    this.resolver.invalidateLatest(companyId);
    try {
      await this.redis.del(latestVersionCacheKey(companyId));
    } catch (err) {
      // The latest-version key has a 5s TTL, so a missed delete only delays visibility.
      this.logger.warn(`Could not invalidate config cache for company ${companyId}: ${(err as Error).message}`);
    }
  }
}

function snapshotOf(row: ConfigVersion | null): PublishedSnapshot | null {
  return row ? (row.snapshot as unknown as PublishedSnapshot) : null;
}
