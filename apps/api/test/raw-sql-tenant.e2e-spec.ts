import { randomUUID } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { WorkflowDecisionLogService } from '../src/common/workflow-engine/workflow-decision-log.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { authed, unwrap } from './helpers/e2e-http';
import { seedWorkflowMasterData, type WorkflowContext } from './helpers/workflow-fixture';

type ShopRow = { shop_id: string };

/**
 * Raw SQL runs with the same tenant settings as model calls. With FORCE RLS a raw
 * statement that has none reads no rows and rejects writes, without any error on reads.
 */
describe('Raw SQL under row-level security (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: WorkflowContext;
  let b: WorkflowContext;
  jest.setTimeout(60_000);

  beforeAll(async () => {
    if (!E2E_DB_ENABLED) return;
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    a = await seedWorkflowMasterData(app);
    b = await seedWorkflowMasterData(app);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // Awaited inside: Prisma queries are lazy and run in the context they are awaited in.
  const asTenant = <T>(companyId: string, fn: () => Promise<T>): Promise<T> =>
    TenantContext.run({ companyId, inRLSTx: false, systemAccess: false }, async () => await fn());

  const shopsSeen = (rows: ShopRow[]) => [...new Set(rows.map((r) => r.shop_id))];
  const inBothShops = () => Prisma.sql`SELECT shop_id FROM product_plants WHERE shop_id IN (${a.shopId}::uuid, ${b.shopId}::uuid)`;

  it('every raw call form sees only the current tenant', async () => {
    if (!E2E_DB_ENABLED) return;
    await asTenant(a.companyId, async () => {
      expect(shopsSeen(await prisma.$queryRaw<ShopRow[]>(inBothShops()))).toEqual([a.shopId]);
      expect(
        shopsSeen(await prisma.$queryRaw<ShopRow[]>`SELECT shop_id FROM product_plants WHERE shop_id IN (${a.shopId}::uuid, ${b.shopId}::uuid)`),
      ).toEqual([a.shopId]);
      expect(
        shopsSeen(
          await prisma.$queryRawUnsafe<ShopRow[]>(
            'SELECT shop_id FROM product_plants WHERE shop_id IN ($1::uuid, $2::uuid)',
            a.shopId,
            b.shopId,
          ),
        ),
      ).toEqual([a.shopId]);
    });
    await asTenant(b.companyId, async () => {
      expect(shopsSeen(await prisma.$queryRaw<ShopRow[]>(inBothShops()))).toEqual([b.shopId]);
    });
  });

  it('concurrent raw queries, as reports run them, each keep the tenant', async () => {
    if (!E2E_DB_ENABLED) return;
    const [first, second] = await Promise.all([
      asTenant(a.companyId, () => prisma.$queryRaw<ShopRow[]>(inBothShops())),
      asTenant(b.companyId, () => prisma.$queryRaw<ShopRow[]>(inBothShops())),
    ]);
    expect(shopsSeen(first)).toEqual([a.shopId]);
    expect(shopsSeen(second)).toEqual([b.shopId]);
  });

  it('explicit system access sees every tenant', async () => {
    if (!E2E_DB_ENABLED) return;
    const rows = await TenantContext.runWithSystemAccess(async () => await prisma.$queryRaw<ShopRow[]>(inBothShops()));
    expect(shopsSeen(rows).sort()).toEqual([a.shopId, b.shopId].sort());
  });

  it('raw queries still work in batch and interactive transactions', async () => {
    if (!E2E_DB_ENABLED) return;
    await asTenant(a.companyId, async () => {
      const [rows, shops] = await prisma.$transaction([
        prisma.$queryRaw<ShopRow[]>(inBothShops()),
        prisma.shop.count({ where: { id: a.shopId } }),
      ]);
      expect(shopsSeen(rows)).toEqual([a.shopId]);
      expect(shops).toBe(1);

      const inside = await prisma.$transaction(async (tx) => ({
        onTx: await tx.$queryRaw<ShopRow[]>(inBothShops()),
        // A service using its injected client during a transaction: its own connection, still scoped.
        onClient: await prisma.$queryRaw<ShopRow[]>(inBothShops()),
      }));
      expect(shopsSeen(inside.onTx)).toEqual([a.shopId]);
      expect(shopsSeen(inside.onClient)).toEqual([a.shopId]);
    });
  });

  it('a failing raw statement rolls back and rejects, and is not run twice', async () => {
    if (!E2E_DB_ENABLED) return;
    const query = asTenant(a.companyId, () => prisma.$queryRaw`SELECT * FROM no_such_table_e2e`);
    await expect(query).rejects.toThrow(/no_such_table_e2e/);

    const marker = randomUUID();
    await asTenant(a.companyId, async () => {
      const insert = prisma.$executeRaw`
        INSERT INTO notification_policies (id, company_id, name, scope, updated_at)
        VALUES (gen_random_uuid(), ${a.companyId}::uuid, ${marker}, 'dunning', now())`;
      // Awaited twice: a promise runs once, whichever way it is consumed.
      await insert;
      await insert;
      expect(await prisma.notificationPolicy.count({ where: { name: marker } })).toBe(1);
      await prisma.notificationPolicy.deleteMany({ where: { name: marker } });
    });
  });

  it('a raw write cannot create another tenant\'s row', async () => {
    if (!E2E_DB_ENABLED) return;
    await expect(
      asTenant(a.companyId, () => prisma.$executeRaw`
        INSERT INTO notification_policies (id, company_id, name, scope, updated_at)
        VALUES (gen_random_uuid(), ${b.companyId}::uuid, ${randomUUID()}, 'dunning', now())`),
    ).rejects.toThrow(/row-level security/);
  });

  it('workflow decision logs are written, for that tenant only', async () => {
    if (!E2E_DB_ENABLED) return;
    const eventId = randomUUID();
    await asTenant(a.companyId, () =>
      app.get(WorkflowDecisionLogService).record({
        eventId,
        correlationId: randomUUID(),
        companyId: a.companyId,
        eventType: 'e2e.raw-sql',
        channel: 'EMAIL',
        priority: 'NORMAL',
        outcome: 'DELIVERED',
        reason: 'raw sql regression',
      }),
    );
    expect(await asTenant(a.companyId, () => prisma.workflowDecisionLog.count({ where: { eventId } }))).toBe(1);
    expect(await asTenant(b.companyId, () => prisma.workflowDecisionLog.count({ where: { eventId } }))).toBe(0);
  });

  it('reports built on raw SQL show real figures over HTTP', async () => {
    if (!E2E_DB_ENABLED) return;
    // The fixture product has min stock 5 and no stock, so it is low stock in tenant A.
    const res = await authed(app, a.token).get('/api/v1/reports/analytics/overview').query({ shop_id: a.shopId }).expect(200);
    const overview = unwrap<{ lowStockCount: number }>(res.body);
    expect(overview.lowStockCount).toBe(1);
  });
});
