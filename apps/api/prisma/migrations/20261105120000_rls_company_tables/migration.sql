-- Tenant isolation for the remaining tables whose company_id is NOT NULL
-- (#238, part 3), in the same fail-closed form as
-- 20261104200000_rls_money_stock_credentials: a row is visible or writable only
-- inside its own company's context, or with explicit unscoped (system) access.
-- Background jobs, timers and @Public routes (webhooks, portals) already run
-- with system access, so they are unaffected.
DO $$
DECLARE
  t text;
  unscoped constant text := 'current_setting(''app.allow_unscoped_access'', true) = ''true''';
  company constant text := '(NULLIF(current_setting(''app.current_company_id'', true), ''''))::uuid';
  cond text := format('(%s OR company_id = %s)', unscoped, company);
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- AI agent platform
    'agent_tasks', 'ai_prompt_history', 'ai_settings', 'ai_usage_logs', 'conversations',
    'user_channel_links', 'whatsapp_devices', 'whatsapp_link_tokens', 'whatsapp_verifications',
    -- Notifications and messaging
    'notifications', 'notification_audit_logs', 'notification_deliveries', 'notification_preferences',
    'notification_rules', 'notification_subscriptions', 'notification_templates',
    'document_email_outbox', 'customer_contact_channels', 'followup_threads', 'outbox_events',
    -- Devices
    'device_registrations', 'user_devices',
    -- Company settings, scanning and lifecycle
    'document_series_config', 'scan_logs', 'company_health_score_configs',
    'company_engagement_snapshots', 'lifecycle_campaign_enrollments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rls_%1$s_company ON %1$I', t);
    EXECUTE format('CREATE POLICY rls_%1$s_company ON %1$I USING %2$s WITH CHECK %2$s', t, cond);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
