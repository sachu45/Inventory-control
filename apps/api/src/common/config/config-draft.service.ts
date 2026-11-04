import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TenantModuleConfig } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigValidationException, validateDraftRow } from './config-snapshot';

export class DraftRevisionConflictException extends ConflictException {
  constructor(expectedRevision: number, currentRevision: number) {
    super({
      message: 'This draft was changed by someone else; reload it and try again',
      code: 'CONFIG_DRAFT_REVISION_CONFLICT',
      expectedRevision,
      currentRevision,
    });
  }
}

/**
 * Admin edits to the draft working set. Tenants never read drafts; nothing here
 * changes live config until ConfigPublishService publishes.
 */
@Injectable()
export class ConfigDraftService {
  constructor(private readonly prisma: PrismaService) {}

  list(companyId: string): Promise<TenantModuleConfig[]> {
    return this.prisma.tenantModuleConfig.findMany({
      where: { companyId },
      orderBy: [{ moduleKey: 'asc' }, { shopId: 'asc' }],
    });
  }

  async create(args: {
    companyId: string;
    shopId?: string | null;
    moduleKey: string;
    enabled?: boolean | null;
    config?: Record<string, unknown>;
    actorId: string;
  }): Promise<TenantModuleConfig> {
    const row = {
      shopId: args.shopId ?? null,
      moduleKey: args.moduleKey,
      enabled: args.enabled ?? null,
      config: args.config ?? {},
    };
    await this.validate(args.companyId, row);
    try {
      return await this.prisma.tenantModuleConfig.create({
        data: { companyId: args.companyId, ...row, config: row.config as Prisma.InputJsonValue, updatedBy: args.actorId },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          message: 'A draft for this module and scope already exists',
          code: 'CONFIG_DRAFT_EXISTS',
        });
      }
      throw err;
    }
  }

  /** `enabled: null` resets to inherit; an omitted field is left unchanged. */
  async update(args: {
    companyId: string;
    id: string;
    expectedRevision: number;
    enabled?: boolean | null;
    config?: Record<string, unknown>;
    actorId: string;
  }): Promise<TenantModuleConfig> {
    const existing = await this.findOwned(args.companyId, args.id);
    const next = {
      shopId: existing.shopId,
      moduleKey: existing.moduleKey,
      enabled: args.enabled === undefined ? existing.enabled : args.enabled,
      config: args.config ?? existing.config,
    };
    await this.validate(args.companyId, next);

    const { count } = await this.prisma.tenantModuleConfig.updateMany({
      where: { id: args.id, companyId: args.companyId, revision: args.expectedRevision },
      data: {
        enabled: next.enabled,
        config: next.config as Prisma.InputJsonValue,
        revision: { increment: 1 },
        updatedBy: args.actorId,
      },
    });
    if (count === 0) await this.throwStale(args.companyId, args.id, args.expectedRevision);
    return this.findOwned(args.companyId, args.id);
  }

  async remove(args: { companyId: string; id: string; expectedRevision: number }): Promise<void> {
    const { count } = await this.prisma.tenantModuleConfig.deleteMany({
      where: { id: args.id, companyId: args.companyId, revision: args.expectedRevision },
    });
    if (count === 0) await this.throwStale(args.companyId, args.id, args.expectedRevision);
  }

  private async validate(
    companyId: string,
    row: { shopId: string | null; moduleKey: string; enabled: boolean | null; config: unknown },
  ): Promise<void> {
    const issues = validateDraftRow(row);
    if (row.shopId !== null) {
      const shop = await this.prisma.shop.findFirst({ where: { id: row.shopId, companyId }, select: { id: true } });
      if (!shop) issues.push({ path: 'shopId', message: 'Shop does not belong to this company' });
    }
    if (issues.length) throw new ConfigValidationException(issues);
  }

  private async findOwned(companyId: string, id: string): Promise<TenantModuleConfig> {
    const row = await this.prisma.tenantModuleConfig.findFirst({ where: { id, companyId } });
    if (!row) throw new NotFoundException('Config draft not found');
    return row;
  }

  private async throwStale(companyId: string, id: string, expectedRevision: number): Promise<never> {
    const current = await this.findOwned(companyId, id);
    throw new DraftRevisionConflictException(expectedRevision, current.revision);
  }
}
