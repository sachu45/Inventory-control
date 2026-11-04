-- Tenant isolation for the configuration tables, in the same fail-closed form
-- the other tenant tables use (see 20261027100000_fail_closed_tenant_rls): a row
-- is visible or writable only inside its own company's context, or with explicit
-- unscoped (system) access. FORCE applies the policy to the table owner too.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_module_configs', 'config_versions', 'user_preferences'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rls_%I_company ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY rls_%1$I_company ON %1$I '
      || 'USING (current_setting(''app.allow_unscoped_access'', true) = ''true'' '
      || 'OR company_id = (NULLIF(current_setting(''app.current_company_id'', true), ''''))::uuid) '
      || 'WITH CHECK (current_setting(''app.allow_unscoped_access'', true) = ''true'' '
      || 'OR company_id = (NULLIF(current_setting(''app.current_company_id'', true), ''''))::uuid)',
      t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
