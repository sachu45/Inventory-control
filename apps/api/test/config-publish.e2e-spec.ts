import { randomUUID } from 'crypto';
import { ConflictException, HttpStatus } from '@nestjs/common';
import { ConfigPublishService } from '../src/common/config/config-publish.service';
import { ConfigResolverService } from '../src/common/config/config-resolver.service';
import {
  ConfigValidationException,
  ConfigVersionConflictException,
  PublishedSnapshot,
  latestVersionCacheKey,
} from '../src/common/config/config-snapshot';
import { MetricsService } from '../src/common/observability/metrics.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * ConfigPublishService against a real database: publish lifecycle, concurrency,
 * rollback and row immutability. Skips itself when DATABASE_URL is absent.
 */
describe('ConfigPublishService (e2e)', () => {
  const enabled = Boolean(process.env.DATABASE_URL);
  let prisma: PrismaService;
  let service: ConfigPublishService;
  const redis = { get: jest.fn(async () => null), set: jest.fn(async () => 'OK' as const), del: jest.fn(async (_key: string) => 1) };
  let actorId: string;
  const companies: string[] = [];

  const createCompany = async () => {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await prisma.company.create({ data: { id, companyCode: `CFG-${tag}`, companyName: `cfg ${tag}` } });
    const shop = await prisma.shop.create({
      data: {
        companyId: id,
        shopNumber: `CFG-${tag}`,
        shopName: 'cfg shop',
        address: 'n/a',
        contactPerson: 'n/a',
        mobile: '0000000000',
        email: `cfg-${tag}@example.test`,
      },
    });
    companies.push(id);
    return { companyId: id, shopId: shop.id };
  };

  const setDraft = (companyId: string, moduleKey: string, data: { enabled?: boolean | null; config?: object }, shopId: string | null = null) =>
    prisma.tenantModuleConfig.create({
      data: { companyId, shopId, moduleKey, enabled: data.enabled ?? null, config: data.config ?? {} },
    });

  const activeSnapshot = async (companyId: string) =>
    (await service.activeVersion(companyId))?.snapshot as unknown as PublishedSnapshot | undefined;

  beforeAll(async () => {
    if (!enabled) return;
    prisma = new PrismaService();
    // Seeded by the e2e global setup; audit rows reference a real user.
    actorId = (await prisma.user.findFirstOrThrow({ select: { id: true } })).id;
    service = new ConfigPublishService(prisma, new AuditService(prisma), redis, new ConfigResolverService(prisma, redis, new MetricsService()));
  });

  beforeEach(() => redis.del.mockClear());

  afterAll(async () => {
    if (!enabled) return;
    await prisma.company.deleteMany({ where: { id: { in: companies } } });
    await prisma.$disconnect();
  });

  it('publishes version 1, invalidates the cache, and draft edits stay invisible until the next publish', async () => {
    if (!enabled) return;
    const { companyId } = await createCompany();
    const draft = await setDraft(companyId, 'contracts', { enabled: false });

    const { version, changes } = await service.publish({ companyId, expectedBaseVersion: 0, actorId, note: 'first' });
    expect(version).toMatchObject({ version: 1, schemaVersion: 1, sourceVersion: null, changeNote: 'first', publishedBy: actorId });
    expect(changes).toEqual([{ path: 'company.contracts.enabled', before: true, after: false }]);
    expect(redis.del).toHaveBeenCalledWith(latestVersionCacheKey(companyId));
    expect(
      await prisma.auditLog.findFirst({ where: { companyId, entityType: 'ConfigVersion', entityId: version.id } }),
    ).toMatchObject({ userId: actorId, newValues: expect.objectContaining({ version: 1, changeCount: 1 }) });

    await prisma.tenantModuleConfig.update({ where: { id: draft.id }, data: { enabled: true } });
    expect((await activeSnapshot(companyId))?.company.contracts.enabled).toBe(false);

    const preview = await service.compileDraft(companyId);
    expect(preview).toMatchObject({ baseVersion: 1, issues: [] });
    expect(preview.changes).toEqual([{ path: 'company.contracts.enabled', before: false, after: true }]);
    expect(await prisma.configVersion.count({ where: { companyId } })).toBe(1);
  });

  it('lets exactly one of two concurrent publishes on the same base succeed', async () => {
    if (!enabled) return;
    const { companyId } = await createCompany();
    await service.publish({ companyId, expectedBaseVersion: 0, actorId });

    const results = await Promise.allSettled([
      service.publish({ companyId, expectedBaseVersion: 1, actorId }),
      service.publish({ companyId, expectedBaseVersion: 1, actorId }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConfigVersionConflictException);
    expect((rejected[0].reason as ConflictException).getStatus()).toBe(HttpStatus.CONFLICT);
    expect((await service.activeVersion(companyId))?.version).toBe(2);
  });

  it('rejects a publish built on a stale base version', async () => {
    if (!enabled) return;
    const { companyId } = await createCompany();
    await service.publish({ companyId, expectedBaseVersion: 0, actorId });
    await expect(service.publish({ companyId, expectedBaseVersion: 0, actorId })).rejects.toMatchObject({
      response: { code: 'CONFIG_VERSION_CONFLICT', expectedBaseVersion: 0, activeVersion: 1 },
    });
  });

  it('rejects invalid config listing every error, and writes nothing', async () => {
    if (!enabled) return;
    const { companyId } = await createCompany();
    await setDraft(companyId, 'purchase-orders', { config: { hiddenFields: ['supplier'] } });
    await setDraft(companyId, 'products', { enabled: false });

    const error = await service.publish({ companyId, expectedBaseVersion: 0, actorId }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigValidationException);
    const details = (error as ConfigValidationException).details.map((d) => d.path);
    expect(details).toEqual(
      expect.arrayContaining(['modules.purchase-orders.config.hiddenFields.0', 'modules.rfqs.enabled', 'modules.purchase-orders.enabled']),
    );
    expect(await prisma.configVersion.count({ where: { companyId } })).toBe(0);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("rejects drafts that point at another company's shop", async () => {
    if (!enabled) return;
    const { companyId } = await createCompany();
    const other = await createCompany();
    await setDraft(companyId, 'contracts', { enabled: false }, other.shopId);
    await expect(service.publish({ companyId, expectedBaseVersion: 0, actorId })).rejects.toMatchObject({
      details: [{ path: `shops.${other.shopId}`, message: 'Shop does not belong to this company' }],
    });
  });

  it('applies valid shop overrides in the published snapshot', async () => {
    if (!enabled) return;
    const { companyId, shopId } = await createCompany();
    await setDraft(companyId, 'contracts', { enabled: false }, shopId);
    await service.publish({ companyId, expectedBaseVersion: 0, actorId });
    expect((await activeSnapshot(companyId))?.shops).toEqual({ [shopId]: { contracts: { enabled: false, config: {} } } });
  });

  it('rollback publishes a copy of the target as a new version and resets drafts', async () => {
    if (!enabled) return;
    const { companyId } = await createCompany();
    const draft = await setDraft(companyId, 'contracts', { enabled: false });
    await service.publish({ companyId, expectedBaseVersion: 0, actorId });
    await prisma.tenantModuleConfig.update({ where: { id: draft.id }, data: { enabled: true } });
    await service.publish({ companyId, expectedBaseVersion: 1, actorId });

    const { version, changes } = await service.rollback({ companyId, targetVersion: 1, expectedBaseVersion: 2, actorId });
    expect(version).toMatchObject({ version: 3, sourceVersion: 1, changeNote: 'Rollback to version 1' });
    expect(changes).toEqual([{ path: 'company.contracts.enabled', before: true, after: false }]);

    const history = await prisma.configVersion.findMany({ where: { companyId }, orderBy: { version: 'asc' } });
    expect(history.map((v) => v.version)).toEqual([1, 2, 3]);
    const { version: _v1, ...v1 } = history[0].snapshot as unknown as PublishedSnapshot;
    const { version: _v3, ...v3 } = history[2].snapshot as unknown as PublishedSnapshot;
    expect(v3).toEqual(v1);

    expect((await service.compileDraft(companyId)).changes).toEqual([]);
    await expect(service.rollback({ companyId, targetVersion: 99, expectedBaseVersion: 3, actorId })).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
  });

  it('diffs any two versions, with 0 meaning registry defaults', async () => {
    if (!enabled) return;
    const { companyId } = await createCompany();
    await setDraft(companyId, 'contracts', { enabled: false });
    await service.publish({ companyId, expectedBaseVersion: 0, actorId });
    expect(await service.diff(companyId, 0, 1)).toEqual([{ path: 'company.contracts.enabled', before: true, after: false }]);
    expect(await service.diff(companyId, 1, 1)).toEqual([]);
  });

  it('still publishes when the cache is unreachable', async () => {
    if (!enabled) return;
    const { companyId } = await createCompany();
    redis.del.mockRejectedValueOnce(new Error('Stream isn\'t writeable'));
    await expect(service.publish({ companyId, expectedBaseVersion: 0, actorId })).resolves.toMatchObject({
      version: { version: 1 },
    });
  });

  it('refuses to update or delete published versions, but lets a company delete cascade', async () => {
    if (!enabled) return;
    const { companyId } = await createCompany();
    const { version } = await service.publish({ companyId, expectedBaseVersion: 0, actorId });

    await expect(
      prisma.configVersion.update({ where: { id: version.id }, data: { changeNote: 'edited' } }),
    ).rejects.toThrow(/immutable/);
    await expect(prisma.configVersion.delete({ where: { id: version.id } })).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE config_versions')).rejects.toThrow(/immutable/);

    await prisma.company.delete({ where: { id: companyId } });
    expect(await prisma.configVersion.count({ where: { companyId } })).toBe(0);
  });
});
