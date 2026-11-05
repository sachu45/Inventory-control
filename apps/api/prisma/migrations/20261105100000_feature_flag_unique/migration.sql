-- #243: one feature-flag override per (company, flag).
-- FeatureFlagsService.setEnabled used to read then create, so concurrent writes
-- could store duplicates. Keep the most recently updated row of each set, then
-- add a partial unique index that the service's upsert targets.
DO $$
BEGIN
  -- notification_policies has forced RLS; see every company's rows for the dedupe.
  -- Transaction-local, so it ends with this statement's transaction.
  PERFORM set_config('app.allow_unscoped_access', 'true', true);
  DELETE FROM "notification_policies" p
  USING (
    SELECT id,
           row_number() OVER (PARTITION BY company_id, name ORDER BY updated_at DESC, created_at DESC, id DESC) AS rn
    FROM "notification_policies"
    WHERE scope = 'feature-flag'
  ) ranked
  WHERE p.id = ranked.id AND ranked.rn > 1;
  PERFORM set_config('app.allow_unscoped_access', '', true);
END
$$;

CREATE UNIQUE INDEX "notification_policies_feature_flag_key"
  ON "notification_policies" ("company_id", "name")
  WHERE scope = 'feature-flag';
