import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { uniqueCode } from './helpers/e2e-http';
import { seedWorkflowMasterData } from './helpers/workflow-fixture';

type BackfillResult = { assigned: bigint; multi_company: bigint; unplaced: bigint };

/** products.company_id (#241, expand step): set on create, backfilled for existing rows. */
describe('Product owning company (e2e)', () => {
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

  const product = (code: string, createdById?: string) =>
    prisma.product.create({
      data: {
        productCode: code,
        description: code,
        uom: 'PCS',
        category: 'e2e',
        purchasePrice: new Prisma.Decimal(1),
        sellingPrice: new Prisma.Decimal(2),
        createdById: createdById ?? null,
      },
      select: { id: true },
    });

  it('products created through the API belong to the creating company', async () => {
    if (!E2E_DB_ENABLED) return;
    const a = await seedWorkflowMasterData(app);
    const row = await prisma.product.findUniqueOrThrow({ where: { id: a.productId }, select: { companyId: true } });
    expect(row.companyId).toBe(a.companyId);
  });

  it('the backfill assigns single-company products, leaves multi-company ones for a decision, and uses the creator otherwise', async () => {
    if (!E2E_DB_ENABLED) return;
    const a = await seedWorkflowMasterData(app);
    const b = await seedWorkflowMasterData(app);
    const oneCompany = await product(uniqueCode('BF1'));
    const twoCompanies = await product(uniqueCode('BF2'));
    const noPlant = await product(uniqueCode('BF3'), b.user.id);
    await prisma.productPlant.createMany({
      data: [
        { productId: oneCompany.id, shopId: a.shopId },
        { productId: twoCompanies.id, shopId: a.shopId },
        { productId: twoCompanies.id, shopId: b.shopId },
      ],
    });

    const [result] = await prisma.$queryRaw<BackfillResult[]>`SELECT * FROM products_backfill_company_id()`;
    expect(Number(result.assigned)).toBeGreaterThanOrEqual(2);
    expect(Number(result.multi_company)).toBeGreaterThanOrEqual(1);

    const owner = async (id: string) =>
      (await prisma.product.findUniqueOrThrow({ where: { id }, select: { companyId: true } })).companyId;
    expect(await owner(oneCompany.id)).toBe(a.companyId);
    expect(await owner(twoCompanies.id)).toBeNull();
    expect(await owner(noPlant.id)).toBe(b.companyId);

    // Re-running changes nothing that is already set.
    await prisma.$queryRaw`SELECT * FROM products_backfill_company_id()`;
    expect(await owner(oneCompany.id)).toBe(a.companyId);
  });

  it('never leaves the caller unscoped: inside a tenant transaction RLS still applies afterwards', async () => {
    if (!E2E_DB_ENABLED) return;
    const a = await seedWorkflowMasterData(app);
    await seedWorkflowMasterData(app);
    const visible = await TenantContext.run({ companyId: a.companyId, inRLSTx: false, systemAccess: false }, async () =>
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT * FROM products_backfill_company_id()`;
        return tx.company.count();
      }),
    );
    expect(visible).toBe(1);
  });
});
