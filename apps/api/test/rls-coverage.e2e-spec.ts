import type { INestApplication } from '@nestjs/common';
import { TenantContext } from '../src/common/tenant/tenant-context';
import { PrismaService } from '../src/prisma/prisma.service';
import { createE2eApp, E2E_DB_ENABLED } from './helpers/e2e-bootstrap';
import { seedWorkflowMasterData } from './helpers/workflow-fixture';

/**
 * Tables that carry `company_id` or `shop_id` but do not have forced RLS yet.
 * #238 is working this list down; remove a table here in the migration that
 * protects it. A new tenant table must ship with RLS or be added here with a
 * reason, so nothing becomes tenant data without a decision.
 */
const PENDING_RLS: Record<string, string> = {
  // company_id is nullable: decide what a NULL row means before adding a policy.
  audit_logs: 'nullable company_id (platform events)',
  channel_accounts: 'nullable company_id',
  subscription_payments: 'nullable company_id',
  // Remaining tenant tables (#238).
  agent_tasks: '#238',
  ai_prompt_history: '#238',
  ai_settings: '#238',
  ai_usage_logs: '#238',
  alert_events: '#238',
  company_engagement_snapshots: '#238',
  company_health_score_configs: '#238',
  conversations: '#238',
  customer_contact_channels: '#238',
  device_registrations: '#238',
  document_email_outbox: '#238',
  document_series_config: '#238',
  followup_threads: '#238',
  lifecycle_campaign_enrollments: '#238',
  media_assets: '#238',
  notification_audit_logs: '#238',
  notification_deliveries: '#238',
  notification_preferences: '#238',
  notification_rules: '#238',
  notification_subscriptions: '#238',
  notification_templates: '#238',
  notifications: '#238',
  outbox_events: '#238',
  platform_notifications: '#238',
  product_barcodes: '#238',
  scan_logs: '#238',
  user_channel_links: '#238',
  user_devices: '#238',
  user_invitations: '#238',
  whatsapp_devices: '#238',
  whatsapp_link_tokens: '#238',
  whatsapp_verifications: '#238',
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
});
