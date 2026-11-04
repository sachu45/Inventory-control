import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { BillingCycle, RoleName, SubscriptionPlan, SubscriptionStatus } from '@prisma/client';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../src/common/cache/redis.provider';
import { ConfigDraftService, DraftRevisionConflictException } from '../src/common/config/config-draft.service';
import { ConfigPublishService } from '../src/common/config/config-publish.service';
import { ConfigResolverService } from '../src/common/config/config-resolver.service';
import { ConfigVersionConflictException } from '../src/common/config/config-snapshot';
import { ModuleRegistryService } from '../src/common/config/module-registry.service';
import { UserPreferenceService } from '../src/common/config/user-preference.service';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';

type Tenant = { companyId: string; shopId: string; userId: string };

/**
 * Phase 1 isolation suite (spec §9.4): tenants can never see or affect each
 * other's config, and config can only narrow what plan and permissions allow.
 * Meaningful only when the database role does not bypass RLS (CI runs it that way).
 */
describe('Tenant config isolation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let drafts: ConfigDraftService;
  let publisher: ConfigPublishService;
  let resolver: ConfigResolverService;
  let preferences: UserPreferenceService;
  let registry: ModuleRegistryService;
  let a: Tenant;
  let b: Tenant;
  const created: string[] = [];
  /** Superusers and BYPASSRLS roles skip RLS, so database-level isolation cannot be observed. */
  let roleBypassesRls = false;
  const requireRls = (test: string) => {
    if (!roleBypassesRls) return true;
    console.warn(`[tenant-isolation] SKIPPED "${test}": DATABASE_URL role bypasses RLS. CI runs as a non-superuser owner.`);
    return false;
  };

  const asTenant = <T>(tenant: Tenant, fn: () => Promise<T>) =>
    TenantContext.run({ companyId: tenant.companyId, inRLSTx: false, systemAccess: false }, async () => await fn());

  const createTenant = async (plan: SubscriptionPlan): Promise<Tenant> => {
    const tag = randomUUID().slice(0, 8).toUpperCase();
    const role = await prisma.role.findFirstOrThrow({ where: { name: RoleName.OWNER } });
    const company = await prisma.company.create({
      data: {
        companyCode: `ISO-${tag}`,
        companyName: `Isolation ${tag}`,
        subscriptionPlan: plan,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        billingCycle: plan === SubscriptionPlan.TRIAL ? null : BillingCycle.YEARLY,
      },
    });
    created.push(company.id);
    const shop = await prisma.shop.create({
      data: {
        companyId: company.id,
        shopNumber: `ISO-${tag}`,
        shopName: `Isolation shop ${tag}`,
        address: 'n/a',
        contactPerson: 'n/a',
        mobile: '0000000000',
        email: `iso-${tag.toLowerCase()}@e2e.local`,
      },
    });
    const user = await prisma.user.create({
      data: {
        name: `Isolation owner ${tag}`,
        email: `iso-owner-${tag.toLowerCase()}@e2e.local`,
        passwordHash: 'not-used',
        roleId: role.id,
        shopId: shop.id,
      },
    });
    return { companyId: company.id, shopId: shop.id, userId: user.id };
  };

  const configKeys = async (tenant: Tenant) => {
    const keys = [
      ...(await redis.keys(`cfg:v1:${tenant.companyId}:*`)),
      ...(await redis.keys(`cfg:v1:pref:${tenant.companyId}:*`)),
    ].sort();
    return Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await redis.get(k)] as const)));
  };

  beforeAll(async () => {
    if (!E2E_DB_ENABLED) return;
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    redis = app.get<Redis>(REDIS_CLIENT);
    drafts = app.get(ConfigDraftService);
    publisher = app.get(ConfigPublishService);
    resolver = app.get(ConfigResolverService);
    preferences = app.get(UserPreferenceService);
    registry = app.get(ModuleRegistryService);
    const [role] = await prisma.$queryRaw<{ bypass: boolean }[]>`SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    roleBypassesRls = role.bypass;

    a = await createTenant(SubscriptionPlan.PLUS);
    b = await createTenant(SubscriptionPlan.TRIAL);
    await drafts.create({ companyId: b.companyId, moduleKey: 'contracts', enabled: false, actorId: b.userId });
    await publisher.publish({ companyId: b.companyId, expectedBaseVersion: 0, actorId: b.userId });
    await asTenant(b, () => preferences.set(b.userId, 'sidebar', { pinned: ['invoices'] }));
  });

  afterAll(async () => {
    if (!E2E_DB_ENABLED) return;
    await prisma.company.deleteMany({ where: { id: { in: created } } });
    await app.close();
  });

  describe("company A cannot read company B's config, preferences or snapshots", () => {
    it('row-level security hides B rows from A even when queried by B id', async () => {
      if (!E2E_DB_ENABLED || !requireRls('RLS hides B rows')) return;
      const seenFromA = await asTenant(a, async () => ({
        drafts: await prisma.tenantModuleConfig.findMany({ where: { companyId: b.companyId } }),
        versions: await prisma.configVersion.findMany({ where: { companyId: b.companyId } }),
        prefs: await prisma.userPreference.findMany({ where: { userId: b.userId } }),
      }));
      expect(seenFromA).toEqual({ drafts: [], versions: [], prefs: [] });

      const seenFromB = await asTenant(b, async () => ({
        drafts: await prisma.tenantModuleConfig.count({ where: { companyId: b.companyId } }),
        versions: await prisma.configVersion.count({ where: { companyId: b.companyId } }),
        prefs: await prisma.userPreference.count({ where: { userId: b.userId } }),
      }));
      expect(seenFromB).toEqual({ drafts: 1, versions: 1, prefs: 1 });
    });

    it("row-level security rejects A writing rows into B's config", async () => {
      if (!E2E_DB_ENABLED || !requireRls('RLS rejects cross-tenant writes')) return;
      await expect(
        asTenant(a, () => prisma.tenantModuleConfig.create({ data: { companyId: b.companyId, moduleKey: 'rfqs' } })),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asTenant(a, () =>
          prisma.userPreference.create({ data: { companyId: b.companyId, userId: b.userId, scope: 'sales' } }),
        ),
      ).rejects.toThrow(/row-level security/);
      expect(await prisma.tenantModuleConfig.count({ where: { companyId: b.companyId, moduleKey: 'rfqs' } })).toBe(0);
    });

    it("A's resolver and preferences never return B's values", async () => {
      if (!E2E_DB_ENABLED) return;
      const resolved = await asTenant(a, () => resolver.resolve());
      expect(resolved).toMatchObject({ companyId: a.companyId, version: 0 });
      expect(resolved.modules.contracts.enabled).toBe(true);
      expect(await asTenant(a, () => preferences.get(b.userId))).toEqual({});
    });
  });

  it("publishing for A does not change B's resolved config or cache keys", async () => {
    if (!E2E_DB_ENABLED) return;
    const bBefore = await asTenant(b, () => resolver.resolve({ explain: true }));
    await asTenant(b, () => preferences.get(b.userId));
    const keysBefore = await configKeys(b);
    expect(Object.keys(keysBefore).length).toBeGreaterThan(0);

    await drafts.create({ companyId: a.companyId, moduleKey: 'rfqs', enabled: false, actorId: a.userId });
    await publisher.publish({ companyId: a.companyId, expectedBaseVersion: 0, actorId: a.userId });
    resolver.invalidateLatest(b.companyId);

    expect(await configKeys(b)).toEqual(keysBefore);
    expect(await asTenant(b, () => resolver.resolve({ explain: true }))).toEqual(bBefore);
    const aAfter = await asTenant(a, () => resolver.resolve());
    expect(aAfter).toMatchObject({ companyId: a.companyId, version: 1 });
    expect(aAfter.modules.rfqs.enabled).toBe(false);
  });

  it('cache keys come from TenantContext, never request input', async () => {
    if (!E2E_DB_ENABLED) return;
    const spoofed = await asTenant(a, () => resolver.resolve({ companyId: b.companyId } as never));
    expect(spoofed.companyId).toBe(a.companyId);
    expect(spoofed.modules.contracts.enabled).toBe(true);
    expect(Object.keys(await configKeys(a)).every((k) => k.includes(a.companyId))).toBe(true);
  });

  it('a module enabled in config but blocked by plan or permission stays blocked', async () => {
    if (!E2E_DB_ENABLED) return;
    // B is on TRIAL; purchase orders are enabled in its config (the default).
    const bConfig = await asTenant(b, () => resolver.resolve());
    expect(bConfig.modules['purchase-orders'].enabled).toBe(true);
    const everything = new Set(['purchase_order:read', 'product:read', 'supplier:read', 'report:view']);
    expect(registry.isUsable('purchase-orders', bConfig, SubscriptionPlan.TRIAL, everything)).toBe(false);
    expect(registry.isUsable('reports', bConfig, SubscriptionPlan.TRIAL, everything)).toBe(false);

    const aConfig = await asTenant(a, () => resolver.resolve());
    expect(registry.isUsable('purchase-orders', aConfig, SubscriptionPlan.PLUS, everything)).toBe(true);
    expect(registry.isUsable('purchase-orders', aConfig, SubscriptionPlan.PLUS, new Set())).toBe(false);
    // Disabled in config stays disabled whatever the plan and permissions.
    expect(registry.isUsable('rfqs', aConfig, SubscriptionPlan.PLUS, new Set(['rfq:read', 'product:read', 'supplier:read']))).toBe(false);
  });

  it('concurrent publishes for one company: exactly one succeeds', async () => {
    if (!E2E_DB_ENABLED) return;
    const base = (await asTenant(a, () => publisher.activeVersion(a.companyId)))!.version;
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        asTenant(a, () => publisher.publish({ companyId: a.companyId, expectedBaseVersion: base, actorId: a.userId })),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(3);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(ConfigVersionConflictException);
    expect((await asTenant(a, () => publisher.activeVersion(a.companyId)))!.version).toBe(base + 1);
  });

  it('concurrent edits of one draft row: the second writer gets 409', async () => {
    if (!E2E_DB_ENABLED) return;
    const row = await drafts.create({ companyId: a.companyId, moduleKey: 'contracts', enabled: null, actorId: a.userId });
    const results = await Promise.allSettled([
      drafts.update({ companyId: a.companyId, id: row.id, expectedRevision: 1, enabled: false, actorId: a.userId }),
      drafts.update({ companyId: a.companyId, id: row.id, expectedRevision: 1, enabled: true, actorId: a.userId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [loser] = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(loser.reason).toBeInstanceOf(DraftRevisionConflictException);
    expect(loser.reason.getStatus()).toBe(409);
    expect((await prisma.tenantModuleConfig.findUniqueOrThrow({ where: { id: row.id } })).revision).toBe(2);
  });
});
