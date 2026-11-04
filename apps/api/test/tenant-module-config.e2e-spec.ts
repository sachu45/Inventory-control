import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { createPgAdapter } from '../src/prisma/pg-adapter';

/**
 * Schema-level guarantees of the tenant_module_configs draft table.
 * Skips itself when DATABASE_URL is absent, like the other DB-backed specs.
 */
describe('TenantModuleConfig schema (e2e)', () => {
  const enabled = Boolean(process.env.DATABASE_URL);
  let prisma: PrismaClient;
  const companyId = randomUUID();
  const shopId = randomUUID();
  const suffix = companyId.slice(0, 8);

  // Tenant RLS is fail-closed, so fixture work runs with explicit system access.
  const asSystem = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_unscoped_access', 'true', true)`;
      return fn(tx);
    });

  const insertConfig = (moduleKey: string, scopeShopId: string | null) =>
    asSystem((tx) =>
      tx.tenantModuleConfig.create({ data: { companyId, shopId: scopeShopId, moduleKey } }),
    );

  beforeAll(async () => {
    if (!enabled) return;
    prisma = new PrismaClient({ adapter: createPgAdapter() });
    await asSystem(async (tx) => {
      await tx.company.create({
        data: { id: companyId, companyCode: `TMC-${suffix}`, companyName: 'TMC test co' },
      });
      await tx.shop.create({
        data: {
          id: shopId,
          companyId,
          shopNumber: `TMC-${suffix}`,
          shopName: 'TMC test shop',
          address: 'n/a',
          contactPerson: 'n/a',
          mobile: '0000000000',
          email: `tmc-${suffix}@example.test`,
        },
      });
    });
  });

  afterAll(async () => {
    if (!enabled) return;
    await asSystem(async (tx) => {
      await tx.shop.deleteMany({ where: { id: shopId } });
      await tx.company.deleteMany({ where: { id: companyId } });
    });
    await prisma.$disconnect();
  });

  it('rejects a second company-wide row for the same module', async () => {
    if (!enabled) return;
    await insertConfig('sales', null);
    await expect(insertConfig('sales', null)).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows a shop-scoped row alongside the company-wide one, but not two', async () => {
    if (!enabled) return;
    await insertConfig('purchasing', null);
    await insertConfig('purchasing', shopId);
    await expect(insertConfig('purchasing', shopId)).rejects.toMatchObject({ code: 'P2002' });
  });

  it('lets only the first of two writers holding the same revision succeed', async () => {
    if (!enabled) return;
    const row = await insertConfig('inventory', null);
    const writeAt = (revision: number, config: Prisma.InputJsonValue) =>
      asSystem((tx) =>
        tx.tenantModuleConfig.updateMany({
          where: { id: row.id, revision },
          data: { config, revision: { increment: 1 } },
        }),
      );

    const [first, second] = [await writeAt(1, { a: 1 }), await writeAt(1, { b: 1 })];
    expect(first.count).toBe(1);
    expect(second.count).toBe(0);

    const stored = await asSystem((tx) =>
      tx.tenantModuleConfig.findUniqueOrThrow({ where: { id: row.id } }),
    );
    expect(stored).toMatchObject({ revision: 2, config: { a: 1 } });
  });

  it('removes configs when the company is deleted', async () => {
    if (!enabled) return;
    const ghostCompanyId = randomUUID();
    await asSystem(async (tx) => {
      await tx.company.create({
        data: { id: ghostCompanyId, companyCode: `TMC-G-${suffix}`, companyName: 'ghost' },
      });
      await tx.tenantModuleConfig.create({ data: { companyId: ghostCompanyId, moduleKey: 'sales' } });
      await tx.company.delete({ where: { id: ghostCompanyId } });
    });
    const remaining = await asSystem((tx) =>
      tx.tenantModuleConfig.count({ where: { companyId: ghostCompanyId } }),
    );
    expect(remaining).toBe(0);
  });
});
