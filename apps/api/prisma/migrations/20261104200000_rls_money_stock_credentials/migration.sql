-- Tenant isolation for money, stock and credential tables (#238), in the same
-- fail-closed form as the other tenant tables (20261027100000_fail_closed_tenant_rls):
-- a row is visible or writable only inside its own company's context, or with
-- explicit unscoped (system) access. FORCE applies the policy to the table owner,
-- including stock triggers, which run in the same transaction and so see the
-- same tenant settings.
DO $$
DECLARE
  t text;
  unscoped constant text := 'current_setting(''app.allow_unscoped_access'', true) = ''true''';
  company constant text := '(NULLIF(current_setting(''app.current_company_id'', true), ''''))::uuid';
  cond text;
BEGIN
  -- Rows owned through their shop: the shop must belong to the current company.
  FOREACH t IN ARRAY ARRAY[
    'stock_ledger', 'stock_summary', 'cost_layers', 'product_plants',
    'payment_receipts', 'credit_notes', 'supplier_bill_header', 'supplier_payments'
  ] LOOP
    cond := format('(%s OR EXISTS (SELECT 1 FROM shops s WHERE s.id = %I.shop_id AND s.company_id = %s))', unscoped, t, company);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rls_%1$s_company ON %1$I', t);
    EXECUTE format('CREATE POLICY rls_%1$s_company ON %1$I USING %2$s WITH CHECK %2$s', t, cond);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;

  -- Rows that carry their company directly (company_id is NOT NULL on all of these).
  FOREACH t IN ARRAY ARRAY[
    'inventory_lots', 'approval_requests', 'company_settings',
    'backup_jobs', 'backup_provider_credentials',
    'email_sender_identities', 'email_sender_domains', 'subscription_invoices'
  ] LOOP
    cond := format('(%s OR company_id = %s)', unscoped, company);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rls_%1$s_company ON %1$I', t);
    EXECUTE format('CREATE POLICY rls_%1$s_company ON %1$I USING %2$s WITH CHECK %2$s', t, cond);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
