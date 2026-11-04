-- Tenant isolation for business documents and inventory tables (#238, part 2),
-- in the same fail-closed form as 20261104200000_rls_money_stock_credentials:
-- a row is visible or writable only inside its own company's context, or with
-- explicit unscoped (system) access. Public portals (supplier portal, quotation
-- portal, supplier return links) run with explicit system access, so they are
-- unaffected.
DO $$
DECLARE
  t text;
  unscoped constant text := 'current_setting(''app.allow_unscoped_access'', true) = ''true''';
  company constant text := '(NULLIF(current_setting(''app.current_company_id'', true), ''''))::uuid';
  cond text;
BEGIN
  -- Rows owned through their shop (shop_id is NOT NULL on all of these).
  FOREACH t IN ARRAY ARRAY[
    'rfq_header', 'supplier_quote_header', 'contract_header', 'sales_quote_header',
    'customer_returns', 'supplier_returns', 'eway_bills', 'damaged_stock', 'document_sequences'
  ] LOOP
    cond := format('(%s OR EXISTS (SELECT 1 FROM shops s WHERE s.id = %I.shop_id AND s.company_id = %s))', unscoped, t, company);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rls_%1$s_company ON %1$I', t);
    EXECUTE format('CREATE POLICY rls_%1$s_company ON %1$I USING %2$s WITH CHECK %2$s', t, cond);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;

  -- Rows that carry their company directly (company_id is NOT NULL on all of these).
  FOREACH t IN ARRAY ARRAY[
    'low_stock_alerts', 'stock_count_sessions', 'inventory_exceptions',
    'barcode_history', 'barcode_audit_logs', 'document_branding',
    'backup_artifacts', 'restore_jobs'
  ] LOOP
    cond := format('(%s OR company_id = %s)', unscoped, company);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rls_%1$s_company ON %1$I', t);
    EXECUTE format('CREATE POLICY rls_%1$s_company ON %1$I USING %2$s WITH CHECK %2$s', t, cond);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
