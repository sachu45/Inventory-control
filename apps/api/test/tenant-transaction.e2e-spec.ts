import type { INestApplication } from '@nestjs/common';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { seedWorkflowMasterData } from './helpers/workflow-fixture';

/**
 * Inside `$transaction(fn)` the callback's `tx` client runs on a connection that
 * already has the tenant set. Code it calls may still use the PrismaService client
 * (audit writes, other services); those queries run on another connection and must
 * set the tenant themselves, or RLS hides every row and refuses every write.
 */
describe('Base-client queries inside an open tenant transaction (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  jest.setTimeout(60_000);

  beforeAll(async () => {
    if (!E2E_DB_ENABLED) return;
    app = await createE2eApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const asTenant = <T>(companyId: string, fn: () => Promise<T>) =>
    TenantContext.run({ companyId, inRLSTx: false, systemAccess: false }, async () => await fn());
  const settings = (companyId: string, key: string) =>
    asTenant(companyId, () => prisma.companySetting.count({ where: { companyId, key } }));

  it('model calls, nested $transaction and raw SQL on the base client keep the tenant', async () => {
    if (!E2E_DB_ENABLED) return;
    const a = await seedWorkflowMasterData(app);
    const b = await seedWorkflowMasterData(app);
    const key = `tx-probe-${Date.now()}`;

    await asTenant(a.companyId, () =>
      prisma.$transaction(async (tx) => {
        await tx.companySetting.create({ data: { companyId: a.companyId, key: `${key}-tx`, value: '1' } });
        // Base client, model call: its own connection, same tenant.
        await prisma.companySetting.create({ data: { companyId: a.companyId, key: `${key}-base`, value: '1' } });
        // Base client, a second interactive transaction.
        await prisma.$transaction((tx2) =>
          tx2.companySetting.create({ data: { companyId: a.companyId, key: `${key}-nested`, value: '1' } }),
        );
        // Base client reads see the tenant's committed rows, not another company's.
        expect(await prisma.companySetting.count({ where: { key: `${key}-base` } })).toBe(1);
        const raw = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM company_settings WHERE key = ${`${key}-nested`}`;
        expect(Number(raw[0].n)).toBe(1);
      }),
    );

    for (const suffix of ['tx', 'base', 'nested']) {
      expect(await settings(a.companyId, `${key}-${suffix}`)).toBe(1);
      expect(await settings(b.companyId, `${key}-${suffix}`)).toBe(0);
    }

    // The tenant still can't write into another company from inside a transaction.
    await expect(
      asTenant(a.companyId, () =>
        prisma.$transaction(async () => {
          await prisma.companySetting.create({ data: { companyId: b.companyId, key: `${key}-forged`, value: '1' } });
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
