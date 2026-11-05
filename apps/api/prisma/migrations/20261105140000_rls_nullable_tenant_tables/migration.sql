-- Tenant isolation for the tables whose tenant key can be NULL (#238, part 4).
-- Same fail-closed form as the earlier parts. A row with no tenant key is
-- platform data: only explicit system access sees it.
--
--   audit_logs,            NULL company_id = platform event, or a row not yet bound
--   channel_accounts,      to a company. AuditService writes platform events with
--   subscription_payments  system access; signup and billing webhooks already run
--                          with it.
--   platform_notifications platform-only for every row: PlatformNotificationService
--                          reads and writes it with system access.
--   media_assets           own company, or a shop of it; both NULL = platform.
--   alert_events           through its shop; NULL shop = platform (none are created).
--   user_invitations       through its shop, or for a shop-less invite through the
--                          inviting user's shop.
DO $$
DECLARE
  t text;
  unscoped constant text := 'current_setting(''app.allow_unscoped_access'', true) = ''true''';
  company constant text := '(NULLIF(current_setting(''app.current_company_id'', true), ''''))::uuid';
  own_shop constant text := 'EXISTS (SELECT 1 FROM shops s WHERE s.id = %I.shop_id AND s.company_id = %s)';
  cond text;
BEGIN
  FOR t, cond IN
    SELECT * FROM (VALUES
      ('audit_logs',
        format('(%s OR company_id = %s)', unscoped, company)),
      ('channel_accounts',
        format('(%s OR company_id = %s)', unscoped, company)),
      ('subscription_payments',
        format('(%s OR company_id = %s)', unscoped, company)),
      ('platform_notifications',
        format('(%s)', unscoped)),
      ('media_assets',
        format('(%s OR company_id = %s OR (company_id IS NULL AND %s))', unscoped, company,
               format(own_shop, 'media_assets', company))),
      ('alert_events',
        format('(%s OR %s)', unscoped, format(own_shop, 'alert_events', company))),
      ('user_invitations',
        format('(%s OR %s OR (user_invitations.shop_id IS NULL AND EXISTS ('
               'SELECT 1 FROM users u JOIN shops s ON s.id = u.shop_id '
               'WHERE u.id = user_invitations.invited_by AND s.company_id = %s)))',
               unscoped, format(own_shop, 'user_invitations', company), company))
    ) AS v(t, cond)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rls_%1$s_company ON %1$I', t);
    EXECUTE format('CREATE POLICY rls_%1$s_company ON %1$I USING %2$s WITH CHECK %2$s', t, cond);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
