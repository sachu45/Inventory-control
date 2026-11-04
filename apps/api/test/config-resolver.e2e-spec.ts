import { randomUUID } from 'crypto';
import { ConfigPublishService } from '../src/common/config/config-publish.service';
import { ConfigResolverService } from '../src/common/config/config-resolver.service';
import { MetricsService } from '../src/common/observability/metrics.service';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { AuditService } from '../src/modules/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';

/** Publish -> resolve against a real database, with an in-memory Redis stand-in. */
describe('ConfigResolverService (e2e)', () => {
  const enabled = Boolean(process.env.DATABASE_URL);
  let prisma: PrismaService;
  let publisher: ConfigPublishService;
  let resolver: ConfigResolverService;
  let actorId: string;
  let companyId: string;
  let shopId: string;
  const store = new Map<string, string>();
  const redis = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => (store.set(key, value), 'OK' as const),
    del: async (key: string) => Number(store.delete(key)),
  };

  const asTenant = <T>(fn: () => Promise<T>) =>
    TenantContext.run({ companyId, inRLSTx: false, systemAccess: false }, fn);

  beforeAll(async () => {
    if (!enabled) return;
    prisma = new PrismaService();
    actorId = (await prisma.user.findFirstOrThrow({ select: { id: true } })).id;
    resolver = new ConfigResolverService(prisma, redis, new MetricsService());
    publisher = new ConfigPublishService(prisma, new AuditService(prisma), redis, resolver);
    companyId = randomUUID();
    const tag = companyId.slice(0, 8);
    await prisma.company.create({ data: { id: companyId, companyCode: `RES-${tag}`, companyName: `res ${tag}` } });
    shopId = (
      await prisma.shop.create({
        data: {
          companyId,
          shopNumber: `RES-${tag}`,
          shopName: 'res shop',
          address: 'n/a',
          contactPerson: 'n/a',
          mobile: '0000000000',
          email: `res-${tag}@example.test`,
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!enabled) return;
    await prisma.company.deleteMany({ where: { id: companyId } });
    await prisma.$disconnect();
  });

  it('serves defaults, then each published version immediately on the publishing node', async () => {
    if (!enabled) return;
    expect((await asTenant(() => resolver.resolve())).version).toBe(0);

    await prisma.tenantModuleConfig.create({ data: { companyId, moduleKey: 'contracts', enabled: false } });
    await prisma.tenantModuleConfig.create({ data: { companyId, shopId, moduleKey: 'rfqs', enabled: false } });
    await publisher.publish({ companyId, expectedBaseVersion: 0, actorId });

    const companyWide = await asTenant(() => resolver.resolve());
    expect(companyWide.version).toBe(1);
    expect(companyWide.modules.contracts.enabled).toBe(false);
    expect(companyWide.modules.rfqs.enabled).toBe(true);
    expect((await asTenant(() => resolver.resolve({ shopId }))).modules.rfqs.enabled).toBe(false);

    await prisma.tenantModuleConfig.updateMany({ where: { companyId, shopId: null }, data: { enabled: true } });
    expect((await asTenant(() => resolver.resolve())).modules.contracts.enabled).toBe(false);

    await publisher.publish({ companyId, expectedBaseVersion: 1, actorId });
    const next = await asTenant(() => resolver.resolve());
    expect(next.version).toBe(2);
    expect(next.modules.contracts.enabled).toBe(true);
  });
});
