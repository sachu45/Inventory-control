import type { INestApplication } from '@nestjs/common';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { seedWorkflowMasterData } from './helpers/workflow-fixture';

/**
 * Tables that carry `company_id` or `shop_id` but do not have forced RLS yet.
 * #238 is working this list down; every table with a NOT NULL company_id is
 * done. Remove a table here in the migration that protects it. A new tenant table must ship with RLS or be added here with a
 * reason, so nothing becomes tenant data without a decision.
 */
const PENDING_RLS: Record<string, string> = {
  // company_id is nullable: decide what a NULL row means before adding a policy.
  audit_logs: 'nullable company_id (platform events)',
  channel_accounts: 'nullable company_id',
  subscription_payments: 'nullable company_id',
  // company_id added in the #241 expand step; RLS comes with the contract step, once the backfill is verified.
  products: '#241',
  // No company_id: owned through a nullable shop_id (#238).
  alert_events: 'nullable shop_id',
  user_invitations: 'nullable shop_id',
  // Both nullable: shared/system rows exist alongside tenant rows (#238).
  media_assets: 'nullable company_id and shop_id',
  platform_notifications: 'nullable company_id (platform-wide notices)',
  product_barcodes: 'nullable company_id (moves with products, #241)',
};

describe('Row-level security coverage (e2e)', () => {
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

  it('every table with company_id or shop_id has forced RLS or a pending entry', async () => {
    if (!E2E_DB_ENABLED) return;
    const rows = await TenantContext.runWithSystemAccess(() =>
      prisma.$queryRaw<{ table: string; protected: boolean }[]>`
        SELECT c.relname AS table, (c.relrowsecurity AND c.relforcerowsecurity) AS protected
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attname IN ('company_id', 'shop_id') AND NOT a.attisdropped
          )`,
    );
    const unprotected = rows.filter((r) => !r.protected).map((r) => r.table).sort();
    // New tenant tables must ship with RLS or be listed with a reason.
    expect(unprotected.filter((t) => !(t in PENDING_RLS))).toEqual([]);
    // Protected (or dropped) tables must leave the list, so it only shrinks.
    expect(Object.keys(PENDING_RLS).filter((t) => !unprotected.includes(t)).sort()).toEqual([]);
  });

  it("hides another company's stock, plant and settings rows, and refuses writes into them", async () => {
    if (!E2E_DB_ENABLED) return;
    const a = await seedWorkflowMasterData(app);
    const b = await seedWorkflowMasterData(app);
    await asTenant(b.companyId, () =>
      prisma.companySetting.create({ data: { companyId: b.companyId, key: 'rls-probe', value: 'b' } }),
    );

    // B sees its own rows.
    expect(await asTenant(b.companyId, () => prisma.productPlant.count({ where: { shopId: b.shopId } }))).toBeGreaterThan(0);
    expect(await asTenant(b.companyId, () => prisma.companySetting.count({ where: { companyId: b.companyId } }))).toBe(1);

    // A cannot see them, even when asking by B's ids.
    expect(await asTenant(a.companyId, () => prisma.productPlant.count({ where: { shopId: b.shopId } }))).toBe(0);
    expect(await asTenant(a.companyId, () => prisma.stockLedger.count({ where: { shopId: b.shopId } }))).toBe(0);
    expect(await asTenant(a.companyId, () => prisma.companySetting.count({ where: { companyId: b.companyId } }))).toBe(0);

    // A cannot write rows into B.
    await expect(
      asTenant(a.companyId, () =>
        prisma.companySetting.create({ data: { companyId: b.companyId, key: 'rls-probe-a', value: 'a' } }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asTenant(a.companyId, () =>
        prisma.productPlant.create({ data: { productId: a.productId, shopId: b.shopId } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("hides another company's documents (sales quotations) and refuses updates to them", async () => {
    if (!E2E_DB_ENABLED) return;
    const a = await seedWorkflowMasterData(app);
    const b = await seedWorkflowMasterData(app);
    const quote = await asTenant(b.companyId, () =>
      prisma.salesQuotationHeader.create({
        data: {
          quoteNumber: `SQ-RLS-${Date.now()}`,
          quoteDate: new Date(),
          customerId: b.customerId,
          shopId: b.shopId,
          totalValue: 10,
        },
        select: { id: true },
      }),
    );

    expect(await asTenant(b.companyId, () => prisma.salesQuotationHeader.count({ where: { id: quote.id } }))).toBe(1);
    expect(await asTenant(a.companyId, () => prisma.salesQuotationHeader.count({ where: { id: quote.id } }))).toBe(0);
    // An update from A matches no rows: RLS hides B's row from A's UPDATE.
    const updated = await asTenant(a.companyId, () =>
      prisma.salesQuotationHeader.updateMany({ where: { id: quote.id }, data: { remarks: 'from A' } }),
    );
    expect(updated.count).toBe(0);
  });

  it("hides another company's notifications and AI settings, and refuses writes into them", async () => {
    if (!E2E_DB_ENABLED) return;
    const a = await seedWorkflowMasterData(app);
    const b = await seedWorkflowMasterData(app);
    await asTenant(b.companyId, async () => {
      await prisma.notification.create({ data: { userId: b.user.id, companyId: b.companyId, title: 'rls', message: 'probe', type: 'GOODS_RECEIPT_CREATED', module: 'GOODS_RECEIPT' } });
      await prisma.aiSettings.create({ data: { companyId: b.companyId } });
    });

    expect(await asTenant(b.companyId, () => prisma.notification.count({ where: { userId: b.user.id } }))).toBe(1);
    expect(await asTenant(a.companyId, () => prisma.notification.count({ where: { userId: b.user.id } }))).toBe(0);
    expect(await asTenant(a.companyId, () => prisma.aiSettings.findUnique({ where: { companyId: b.companyId } }))).toBeNull();

    await expect(
      asTenant(a.companyId, () =>
        prisma.notification.create({ data: { userId: b.user.id, companyId: b.companyId, title: 'x', message: 'from A', type: 'GOODS_RECEIPT_CREATED', module: 'GOODS_RECEIPT' } }),
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await asTenant(a.companyId, () =>
      prisma.notification.updateMany({ where: { userId: b.user.id }, data: { isRead: true } }),
    );
    expect(updated.count).toBe(0);
  });
});
