-- CreateTable
CREATE TABLE "config_versions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "source_version" INTEGER,
    "change_note" TEXT,
    "published_by" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "config_versions_version_check" CHECK ("version" >= 1),
    CONSTRAINT "config_versions_source_version_check" CHECK ("source_version" IS NULL OR ("source_version" >= 1 AND "source_version" < "version"))
);

-- CreateIndex
CREATE UNIQUE INDEX "config_versions_company_id_version_key" ON "config_versions"("company_id", "version");

-- AddForeignKey
ALTER TABLE "config_versions" ADD CONSTRAINT "config_versions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Published versions are history: never edited, never removed one by one.
-- A delete is allowed only when it is the FK cascade from deleting the company
-- (the cascade runs inside the RI trigger, so pg_trigger_depth() > 1).
CREATE FUNCTION config_versions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'config_versions rows are immutable (% rejected)', TG_OP;
END;
$$;

CREATE TRIGGER config_versions_immutable
  BEFORE UPDATE OR DELETE ON "config_versions"
  FOR EACH ROW EXECUTE FUNCTION config_versions_immutable();

CREATE TRIGGER config_versions_no_truncate
  BEFORE TRUNCATE ON "config_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION config_versions_immutable();
