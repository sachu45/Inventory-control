import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SubscriptionPlan, SubscriptionStatus, TenantModuleConfig } from '@prisma/client';
import { resolveRolePermissions } from '../../common/auth/role-permissions';
import { ConfigDraftService, DraftRevisionConflictException } from '../../common/config/config-draft.service';
import { ConfigPublishService } from '../../common/config/config-publish.service';
import { ConfigResolverService } from '../../common/config/config-resolver.service';
import { z } from 'zod';
import { MODULE_KEYS, MODULE_REGISTRY, ModuleKey, isModuleKey } from '../../common/config/module-registry';
import { ModuleRegistryService } from '../../common/config/module-registry.service';
import { UserPreferenceService } from '../../common/config/user-preference.service';
import { TenantContext } from '../../common/tenant/tenant-context';
import type { RequestUser } from '../../common/types/request-user';
import { buildMeta, prismaCursorArgs } from '../../common/utils/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformAuditService } from '../platform/platform-audit.service';
import type { ListTenantsQueryDto, SetDraftModuleDto } from './dto/config-admin.dto';

type TenantSummary = {
  id: string;
  companyCode: string;
  companyName: string;
  isActive: boolean;
  subscriptionPlan: SubscriptionPlan;
  subscriptionStatus: SubscriptionStatus;
};

/**
 * Each module's settings schema as JSON Schema, so the admin console can render a form
 * for any setting defined in code. Cross-field refinements are not representable and
 * stay server-side validation.
 */
const CONFIG_JSON_SCHEMAS = Object.fromEntries(
  MODULE_KEYS.map((key) => [
    key,
    z.toJSONSchema(MODULE_REGISTRY[key].configSchema, { unrepresentable: 'any', io: 'input' }),
  ]),
) as unknown as Record<ModuleKey, Record<string, unknown>>;

const CONFIG_AUDIT_ENTITY_TYPES = ['ConfigVersion', 'TenantModuleConfig', 'FeatureFlag', 'CustomFieldDefinition'];

const draftView = (row: TenantModuleConfig | null | undefined) =>
  row ? { id: row.id, enabled: row.enabled, config: row.config, revision: row.revision, updatedAt: row.updatedAt, updatedBy: row.updatedBy } : null;

/**
 * Platform-admin operations on one tenant's config. Every call runs with the
 * target company as the tenant context, so row-level security scopes reads to
 * that company instead of the admin's own.
 */
@Injectable()
export class ConfigAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: ConfigDraftService,
    private readonly publisher: ConfigPublishService,
    private readonly resolver: ConfigResolverService,
    private readonly registry: ModuleRegistryService,
    private readonly preferences: UserPreferenceService,
    private readonly platformAudit: PlatformAuditService,
  ) {}

  assertModuleKey(key: string): ModuleKey {
    if (!isModuleKey(key)) throw new BadRequestException({ message: `Unknown module "${key}"`, code: 'UNKNOWN_MODULE' });
    return key;
  }

  async listTenants(query: ListTenantsQueryDto) {
    const search = query.search?.trim();
    const { take, skip, cursor } = prismaCursorArgs({ take: query.take ?? 20, cursor: query.cursor });
    // Listing tenants is the one cross-company read here; companies has forced RLS.
    const rows = await TenantContext.runWithSystemAccess(() =>
      this.prisma.company.findMany({
      take,
      skip,
      cursor,
      where: search
        ? {
            OR: [
              { companyName: { contains: search, mode: 'insensitive' } },
              { companyCode: { contains: search, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        companyCode: true,
        companyName: true,
        isActive: true,
        subscriptionPlan: true,
        subscriptionStatus: true,
        createdAt: true,
        configVersions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, publishedAt: true } },
      },
    }),
    );
    const { items, meta } = buildMeta(rows, take - 1);
    return {
      items: items.map(({ configVersions, ...company }) => ({ ...company, activeConfig: configVersions[0] ?? null })),
      meta,
    };
  }

  getTenant(companyId: string) {
    return this.inTenant(companyId, async (company) => {
      const [shops, active, draftCount] = await Promise.all([
        this.prisma.shop.findMany({
          where: { companyId },
          orderBy: { shopNumber: 'asc' },
          select: { id: true, shopNumber: true, shopName: true, isActive: true },
        }),
        this.publisher.activeVersion(companyId),
        this.prisma.tenantModuleConfig.count({ where: { companyId } }),
      ]);
      return {
        ...company,
        shops,
        activeConfig: active ? { version: active.version, publishedAt: active.publishedAt, publishedBy: active.publishedBy } : null,
        draftCount,
      };
    });
  }

  listDrafts(companyId: string) {
    return this.inTenant(companyId, async () => {
      const rows = await this.drafts.list(companyId);
      return {
        modules: this.registry.all().map((mod) => ({
          key: mod.key,
          label: mod.label,
          sidebarSection: mod.sidebarSection,
          defaultEnabled: mod.defaultEnabled,
          alwaysEnabled: mod.alwaysEnabled,
          planGate: mod.planGate,
          requiredPermission: mod.requiredPermission,
          dependsOn: mod.dependsOn,
          defaults: mod.defaults,
          customizableFields: mod.customizableFields,
          supportsCustomFields: mod.supportsCustomFields,
          lockedMandatoryFields: mod.lockedMandatoryFields,
          shopOverridable: mod.shopOverridable,
          configSchema: CONFIG_JSON_SCHEMAS[mod.key],
          draft: draftView(rows.find((r) => r.moduleKey === mod.key && r.shopId === null)),
          shops: rows
            .filter((r) => r.moduleKey === mod.key && r.shopId !== null)
            .map((r) => ({ shopId: r.shopId, ...draftView(r) })),
        })),
      };
    });
  }

  /** Creates the draft row for this scope, or updates it when `revision` matches. */
  setDraft(companyId: string, shopId: string | null, key: string, body: SetDraftModuleDto, actor: RequestUser) {
    const moduleKey = this.assertModuleKey(key);
    return this.inTenant(companyId, async () => {
      const existing = await this.findDraft(companyId, shopId, moduleKey);
      let row: TenantModuleConfig;
      if (!existing) {
        if (body.revision !== undefined) throw new DraftRevisionConflictException(body.revision, 0);
        row = await this.drafts.create({
          companyId,
          shopId,
          moduleKey,
          enabled: body.enabled ?? null,
          config: body.config,
          actorId: actor.id,
        });
      } else {
        if (body.revision === undefined) throw new DraftRevisionConflictException(0, existing.revision);
        row = await this.drafts.update({
          companyId,
          id: existing.id,
          expectedRevision: body.revision,
          enabled: body.enabled === undefined ? existing.enabled : body.enabled,
          config: body.config,
          actorId: actor.id,
        });
      }
      await this.audit(actor, companyId, 'platform_config_draft_set', 'TenantModuleConfig', row.id, {
        before: draftView(existing),
        after: { moduleKey, shopId, ...draftView(row) },
      });
      return draftView(row);
    });
  }

  /** Deletes the draft row so the scope falls back to the registry (or company) value. */
  resetDraft(companyId: string, shopId: string | null, key: string, revision: number | undefined, actor: RequestUser) {
    const moduleKey = this.assertModuleKey(key);
    return this.inTenant(companyId, async () => {
      const existing = await this.findDraft(companyId, shopId, moduleKey);
      if (!existing) return { reset: false };
      if (revision === undefined) throw new DraftRevisionConflictException(0, existing.revision);
      await this.drafts.remove({ companyId, id: existing.id, expectedRevision: revision });
      await this.audit(actor, companyId, 'platform_config_draft_reset', 'TenantModuleConfig', existing.id, {
        before: { moduleKey, shopId, ...draftView(existing) },
        after: null,
      });
      return { reset: true };
    });
  }

  preview(companyId: string) {
    return this.inTenant(companyId, () => this.publisher.compileDraft(companyId));
  }

  publish(companyId: string, expectedBaseVersion: number, note: string | undefined, actor: RequestUser) {
    return this.inTenant(companyId, async () => {
      const result = await this.publisher.publish({ companyId, expectedBaseVersion, actorId: actor.id, note });
      await this.audit(actor, companyId, 'platform_config_publish', 'ConfigVersion', result.version.id, {
        before: { version: expectedBaseVersion },
        after: { version: result.version.version, changeCount: result.changes.length },
      });
      return result;
    });
  }

  rollback(companyId: string, targetVersion: number, expectedBaseVersion: number, note: string | undefined, actor: RequestUser) {
    return this.inTenant(companyId, async () => {
      const result = await this.publisher.rollback({ companyId, targetVersion, expectedBaseVersion, actorId: actor.id, note });
      await this.audit(actor, companyId, 'platform_config_rollback', 'ConfigVersion', result.version.id, {
        before: { version: expectedBaseVersion },
        after: { version: result.version.version, sourceVersion: targetVersion, changeCount: result.changes.length },
      });
      return result;
    });
  }

  listVersions(companyId: string) {
    return this.inTenant(companyId, async () =>
      await this.prisma.configVersion.findMany({
        where: { companyId },
        orderBy: { version: 'desc' },
        select: { id: true, version: true, schemaVersion: true, sourceVersion: true, changeNote: true, publishedBy: true, publishedAt: true },
      }),
    );
  }

  getVersion(companyId: string, version: number) {
    return this.inTenant(companyId, async () => {
      const row = await this.prisma.configVersion.findUnique({ where: { companyId_version: { companyId, version } } });
      if (!row) throw new NotFoundException(`Config version ${version} not found`);
      return row;
    });
  }

  diff(companyId: string, from: number, to: number) {
    return this.inTenant(companyId, async () => ({ from, to, changes: await this.publisher.diff(companyId, from, to) }));
  }

  /** What a request in this company (optionally at a shop, as a user) actually runs with. */
  effective(companyId: string, shopId?: string, userId?: string) {
    return this.inTenant(companyId, async (company) => {
      if (shopId) {
        const shop = await this.prisma.shop.findFirst({ where: { id: shopId, companyId }, select: { id: true } });
        if (!shop) throw new NotFoundException('Shop not found in this company');
      }
      const config = await this.resolver.resolve({ shopId: shopId ?? null, explain: true });
      if (!userId) return { config };

      const user = await this.prisma.user.findFirst({
        where: { id: userId, deletedAt: null, shop: { companyId } },
        select: { id: true, email: true, role: { select: { name: true, permissions: true } } },
      });
      if (!user) throw new NotFoundException('User not found in this company');
      const permissions = new Set(await resolveRolePermissions(this.prisma, companyId, user.role));
      return {
        config,
        user: {
          id: user.id,
          email: user.email,
          role: user.role.name,
          usableModules: this.registry.usableModules(config, company.subscriptionPlan, permissions),
          preferences: await this.preferences.get(user.id),
        },
      };
    });
  }

  configAudit(companyId: string, take: number | undefined, cursor: string | undefined) {
    return this.inTenant(companyId, async () => {
      const page = prismaCursorArgs({ take: take ?? 20, cursor });
      const { skip, cursor: from } = page;
      const rows = await this.prisma.auditLog.findMany({
        take: page.take,
        skip,
        cursor: from,
        where: { companyId, entityType: { in: CONFIG_AUDIT_ENTITY_TYPES } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          userId: true,
          oldValues: true,
          newValues: true,
          ipAddress: true,
          createdAt: true,
        },
      });
      return buildMeta(rows, page.take - 1);
    });
  }

  private findDraft(companyId: string, shopId: string | null, moduleKey: ModuleKey) {
    return this.prisma.tenantModuleConfig.findFirst({ where: { companyId, shopId, moduleKey } });
  }

  private async inTenant<T>(
    companyId: string,
    work: (company: TenantSummary) => Promise<T>,
  ): Promise<T> {
    return TenantContext.run({ companyId, inRLSTx: false, systemAccess: false }, async () => {
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
        select: { id: true, companyCode: true, companyName: true, isActive: true, subscriptionPlan: true, subscriptionStatus: true },
      });
      if (!company) throw new NotFoundException('Company not found');
      return work(company);
    });
  }

  private audit(
    actor: RequestUser,
    companyId: string,
    action: 'platform_config_draft_set' | 'platform_config_draft_reset' | 'platform_config_publish' | 'platform_config_rollback',
    entityType: string,
    entityId: string,
    change: { before: unknown; after: unknown },
  ) {
    return this.platformAudit.logPlatformAction({
      userId: actor.id,
      adminEmail: actor.email,
      companyId,
      action,
      entityType,
      entityId,
      oldValues: { value: change.before },
      extra: { after: change.after },
    });
  }
}
