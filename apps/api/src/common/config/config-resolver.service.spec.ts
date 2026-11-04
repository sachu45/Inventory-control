import { ForbiddenException } from '@nestjs/common';
import { MetricsService } from '../observability/metrics.service';
import { TenantContext } from '../tenant/tenant-context';
import { ConfigResolverService, preferencesCacheKey, snapshotCacheKey } from './config-resolver.service';
import { DraftRow, PublishedSnapshot, compileSnapshot, latestVersionCacheKey } from './config-snapshot';
import { MODULE_KEYS, MODULE_REGISTRY } from './module-registry';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_COMPANY = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SHOP = '11111111-1111-1111-1111-111111111111';
const USER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function snapshotFrom(drafts: DraftRow[], version: number): PublishedSnapshot {
  const { snapshot, issues } = compileSnapshot(drafts, new Set([SHOP]), version);
  expect(issues).toEqual([]);
  return snapshot;
}

function setup(rows: Record<string, PublishedSnapshot[]> = {}, prefs: { scope: string; prefs: unknown }[] = []) {
  const store = new Map<string, string>();
  const redis = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK' as const;
    }),
    del: jest.fn(async (key: string) => Number(store.delete(key))),
  };
  const configVersion = {
    findFirst: jest.fn(async ({ where }: { where: { companyId: string } }) => {
      const list = rows[where.companyId] ?? [];
      return list.length ? { version: Math.max(...list.map((s) => s.version)) } : null;
    }),
    findUnique: jest.fn(
      async ({ where }: { where: { companyId_version: { companyId: string; version: number } } }) => {
        const { companyId, version } = where.companyId_version;
        const snap = (rows[companyId] ?? []).find((s) => s.version === version);
        return snap ? { snapshot: snap, schemaVersion: snap.schemaVersion } : null;
      },
    ),
  };
  const userPreference = { findMany: jest.fn(async () => prefs) };
  const prisma = { configVersion, userPreference };
  const metrics = new MetricsService();
  const resolver = new ConfigResolverService(prisma as never, redis as never, metrics);
  return { resolver, redis, store, prisma, metrics };
}

const inTenant = <T>(fn: () => Promise<T>, companyId: string | null = COMPANY) =>
  TenantContext.run({ companyId, inRLSTx: false, systemAccess: false }, fn);

const redisErrors = async (metrics: MetricsService) =>
  (await metrics.configCacheRedisErrors.get()).values.reduce((sum, v) => sum + v.value, 0);

describe('ConfigResolverService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('refuses to resolve outside a tenant context', async () => {
    const { resolver } = setup();
    await expect(resolver.resolve()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(inTenant(() => resolver.resolve(), null)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns registry defaults when nothing is published yet', async () => {
    const { resolver } = setup();
    const resolved = await inTenant(() => resolver.resolve());
    expect(resolved.version).toBe(0);
    for (const key of MODULE_KEYS) {
      expect(resolved.modules[key]).toEqual({
        enabled: MODULE_REGISTRY[key].defaultEnabled,
        config: MODULE_REGISTRY[key].defaults,
      });
    }
  });

  it('serves the latest published snapshot, filling Redis from Postgres', async () => {
    const v2 = snapshotFrom([{ shopId: null, moduleKey: 'contracts', enabled: false, config: {} }], 2);
    const { resolver, store, prisma } = setup({ [COMPANY]: [snapshotFrom([], 1), v2] });

    const resolved = await inTenant(() => resolver.resolve());
    expect(resolved).toMatchObject({ companyId: COMPANY, version: 2 });
    expect(resolved.modules.contracts.enabled).toBe(false);
    expect(store.get(latestVersionCacheKey(COMPANY))).toBe('2');
    expect(JSON.parse(store.get(snapshotCacheKey(COMPANY, 2))!)).toEqual(v2);
    expect(prisma.configVersion.findUnique).toHaveBeenCalledTimes(1);
  });

  it('uses the in-process cache when warm, then Redis, before Postgres', async () => {
    const { resolver, redis, prisma } = setup({ [COMPANY]: [snapshotFrom([], 1)] });
    await inTenant(() => resolver.resolve());
    redis.get.mockClear();
    await inTenant(() => resolver.resolve());
    expect(redis.get).not.toHaveBeenCalled();

    // A second process with an empty local cache reads Redis, not Postgres.
    const other = new ConfigResolverService(prisma as never, redis as never, new MetricsService());
    prisma.configVersion.findFirst.mockClear();
    prisma.configVersion.findUnique.mockClear();
    await inTenant(() => other.resolve());
    expect(prisma.configVersion.findFirst).not.toHaveBeenCalled();
    expect(prisma.configVersion.findUnique).not.toHaveBeenCalled();
  });

  it('re-reads the latest version after the 5s pointer TTL, picking up a new publish', async () => {
    const rows = { [COMPANY]: [snapshotFrom([], 1)] };
    const { resolver, store } = setup(rows);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect((await inTenant(() => resolver.resolve())).version).toBe(1);

    rows[COMPANY].push(snapshotFrom([{ shopId: null, moduleKey: 'contracts', enabled: false, config: {} }], 2));
    store.delete(latestVersionCacheKey(COMPANY)); // what publish does
    now.mockReturnValue(1_004_000);
    expect((await inTenant(() => resolver.resolve())).version).toBe(1);
    now.mockReturnValue(1_005_001);
    expect((await inTenant(() => resolver.resolve())).version).toBe(2);
  });

  it('invalidateLatest makes this process see a publish immediately', async () => {
    const rows = { [COMPANY]: [snapshotFrom([], 1)] };
    const { resolver, store } = setup(rows);
    await inTenant(() => resolver.resolve());
    rows[COMPANY].push(snapshotFrom([], 2));
    store.delete(latestVersionCacheKey(COMPANY));
    resolver.invalidateLatest(COMPANY);
    expect((await inTenant(() => resolver.resolve())).version).toBe(2);
  });

  it('falls through to Postgres when Redis is down, counts it, and never serves defaults', async () => {
    const v1 = snapshotFrom([{ shopId: null, moduleKey: 'contracts', enabled: false, config: {} }], 1);
    const { resolver, redis, metrics } = setup({ [COMPANY]: [v1] });
    const down = new Error('Connection is closed');
    redis.get.mockRejectedValue(down);
    redis.set.mockRejectedValue(down);

    const resolved = await inTenant(() => resolver.resolve());
    expect(resolved.version).toBe(1);
    expect(resolved.modules.contracts.enabled).toBe(false);
    expect(await redisErrors(metrics)).toBe(4);
  });

  it('fails rather than serving defaults when the snapshot cannot be loaded', async () => {
    const { resolver, prisma } = setup({ [COMPANY]: [snapshotFrom([], 1)] });
    prisma.configVersion.findUnique.mockRejectedValue(new Error('database unavailable'));
    await expect(inTenant(() => resolver.resolve())).rejects.toThrow('database unavailable');
  });

  it('ignores a corrupt Redis snapshot and reloads it from Postgres', async () => {
    const { resolver, store, prisma } = setup({ [COMPANY]: [snapshotFrom([], 1)] });
    store.set(latestVersionCacheKey(COMPANY), '1');
    store.set(snapshotCacheKey(COMPANY, 1), '{not json');
    expect((await inTenant(() => resolver.resolve())).version).toBe(1);
    expect(prisma.configVersion.findUnique).toHaveBeenCalledTimes(1);
  });

  it('loads once for many concurrent cold reads', async () => {
    const { resolver, prisma } = setup({ [COMPANY]: [snapshotFrom([], 3)] });
    const results = await inTenant(() => Promise.all(Array.from({ length: 25 }, () => resolver.resolve())));
    expect(new Set(results.map((r) => r.version))).toEqual(new Set([3]));
    expect(prisma.configVersion.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.configVersion.findUnique).toHaveBeenCalledTimes(1);
  });

  it('applies shop overrides, limited to shopOverridable keys', async () => {
    const v1 = snapshotFrom([{ shopId: SHOP, moduleKey: 'contracts', enabled: false, config: {} }], 1);
    // A non-overridable key that somehow reached the snapshot is still ignored.
    v1.shops[SHOP]!['purchase-orders'] = { config: { mandatoryFields: ['remarks'] } };
    const { resolver } = setup({ [COMPANY]: [v1] });

    const atShop = await inTenant(() => resolver.resolve({ shopId: SHOP }));
    expect(atShop.modules.contracts.enabled).toBe(false);
    expect(atShop.modules['purchase-orders'].config.mandatoryFields).toEqual([]);

    const companyWide = await inTenant(() => resolver.resolve());
    expect(companyWide.modules.contracts.enabled).toBe(true);
    const unknownShop = await inTenant(() => resolver.resolve({ shopId: '99999999-9999-9999-9999-999999999999' }));
    expect(unknownShop.modules.contracts.enabled).toBe(true);
  });

  it('explains which layer set each value', async () => {
    const v1 = snapshotFrom(
      [
        { shopId: null, moduleKey: 'purchase-orders', enabled: null, config: { mandatoryFields: ['remarks'] } },
        { shopId: null, moduleKey: 'rfqs', enabled: false, config: {} },
        { shopId: SHOP, moduleKey: 'contracts', enabled: false, config: {} },
      ],
      1,
    );
    const { resolver } = setup({ [COMPANY]: [v1] });
    const plain = await inTenant(() => resolver.resolve({ shopId: SHOP }));
    expect(plain.provenance).toBeUndefined();

    const { provenance } = await inTenant(() => resolver.resolve({ shopId: SHOP, explain: true }));
    expect(provenance).toMatchObject({
      'purchase-orders.enabled': 'registry',
      'purchase-orders.config.mandatoryFields': 'company',
      'purchase-orders.config.hiddenFields': 'registry',
      'rfqs.enabled': 'company',
      'contracts.enabled': 'shop',
    });
  });

  it('scopes every read to the TenantContext company, ignoring smuggled input', async () => {
    const { resolver, prisma } = setup({
      [COMPANY]: [snapshotFrom([], 1)],
      [OTHER_COMPANY]: [snapshotFrom([{ shopId: null, moduleKey: 'contracts', enabled: false, config: {} }], 7)],
    });
    const resolved = await inTenant(() => resolver.resolve({ companyId: OTHER_COMPANY } as never));
    expect(resolved).toMatchObject({ companyId: COMPANY, version: 1 });
    for (const [args] of prisma.configVersion.findFirst.mock.calls) expect(args.where.companyId).toBe(COMPANY);
  });

  it('resolves preferences with mandatory columns un-hidden, cached until invalidated', async () => {
    const v1 = snapshotFrom(
      [{ shopId: null, moduleKey: 'purchase-orders', enabled: null, config: { mandatoryFields: ['remarks'] } }],
      1,
    );
    const { resolver, prisma, store } = setup({ [COMPANY]: [v1] }, [
      { scope: 'purchase-orders', prefs: { hiddenColumns: ['remarks', 'supplier', 'lineCategory'] } },
      { scope: 'sidebar', prefs: { pinned: ['sales'] } },
    ]);

    const prefs = await inTenant(() => resolver.resolvePreferences(USER));
    expect(prefs).toEqual({
      'purchase-orders': { hiddenColumns: ['lineCategory'] },
      sidebar: { pinned: ['sales'] },
    });
    await inTenant(() => resolver.resolvePreferences(USER));
    expect(prisma.userPreference.findMany).toHaveBeenCalledTimes(1);
    expect(store.has(preferencesCacheKey(COMPANY, USER))).toBe(true);

    await resolver.invalidatePreferences(COMPANY, USER);
    expect(store.has(preferencesCacheKey(COMPANY, USER))).toBe(false);
    await inTenant(() => resolver.resolvePreferences(USER));
    expect(prisma.userPreference.findMany).toHaveBeenCalledTimes(2);
  });

  it('resolves in well under 5ms at p99 with a warm in-process cache', async () => {
    const { resolver } = setup({ [COMPANY]: [snapshotFrom([], 1)] });
    await inTenant(() => resolver.resolve({ shopId: SHOP }));
    const samples: number[] = [];
    await inTenant(async () => {
      for (let i = 0; i < 2000; i++) {
        const start = process.hrtime.bigint();
        await resolver.resolve({ shopId: SHOP });
        samples.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
    });
    samples.sort((a, b) => a - b);
    expect(samples[Math.floor(samples.length * 0.99)]).toBeLessThan(5);
  });
});
