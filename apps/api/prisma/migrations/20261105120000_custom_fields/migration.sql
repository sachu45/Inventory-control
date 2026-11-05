-- Custom fields (#167, part 1): tenant field definitions and the columns that will hold
-- their values. Additive: every column is NULL until a published field is set.
--
-- The GIN indexes lock writes on each table while they build, which is brief on small
-- tables. Rollback: drop custom_field_definitions, the indexes and the columns; values
-- would be lost, but none are written until value enforcement ships.

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "custom_fields" JSONB;

-- AlterTable
ALTER TABLE "goods_issue_header" ADD COLUMN     "custom_fields" JSONB;

-- AlterTable
ALTER TABLE "goods_receipt_header" ADD COLUMN     "custom_fields" JSONB;

-- AlterTable
ALTER TABLE "invoice_header" ADD COLUMN     "custom_fields" JSONB;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "custom_fields" JSONB;

-- AlterTable
ALTER TABLE "purchase_order_header" ADD COLUMN     "custom_fields" JSONB;

-- AlterTable
ALTER TABLE "sales_order_header" ADD COLUMN     "custom_fields" JSONB;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "custom_fields" JSONB;

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "module_key" TEXT NOT NULL,
    "field_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "field_type" TEXT NOT NULL,
    "options" JSONB,
    "validation" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "default_value" JSONB,
    "searchable" BOOLEAN NOT NULL DEFAULT false,
    "read_roles" TEXT[],
    "write_roles" TEXT[],
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_company_id_module_key_field_key_key" ON "custom_field_definitions"("company_id", "module_key", "field_key");

-- CreateIndex
CREATE INDEX "customers_custom_fields_idx" ON "customers" USING GIN ("custom_fields" jsonb_path_ops);

-- CreateIndex
CREATE INDEX "goods_issue_header_custom_fields_idx" ON "goods_issue_header" USING GIN ("custom_fields" jsonb_path_ops);

-- CreateIndex
CREATE INDEX "goods_receipt_header_custom_fields_idx" ON "goods_receipt_header" USING GIN ("custom_fields" jsonb_path_ops);

-- CreateIndex
CREATE INDEX "invoice_header_custom_fields_idx" ON "invoice_header" USING GIN ("custom_fields" jsonb_path_ops);

-- CreateIndex
CREATE INDEX "products_custom_fields_idx" ON "products" USING GIN ("custom_fields" jsonb_path_ops);

-- CreateIndex
CREATE INDEX "purchase_order_header_custom_fields_idx" ON "purchase_order_header" USING GIN ("custom_fields" jsonb_path_ops);

-- CreateIndex
CREATE INDEX "sales_order_header_custom_fields_idx" ON "sales_order_header" USING GIN ("custom_fields" jsonb_path_ops);

-- CreateIndex
CREATE INDEX "suppliers_custom_fields_idx" ON "suppliers" USING GIN ("custom_fields" jsonb_path_ops);

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tenant isolation, in the fail-closed form of the other config tables
-- (see 20261104150000_config_tables_rls).
ALTER TABLE "custom_field_definitions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY rls_custom_field_definitions_company ON "custom_field_definitions"
  USING (current_setting('app.allow_unscoped_access', true) = 'true'
    OR company_id = (NULLIF(current_setting('app.current_company_id', true), ''))::uuid)
  WITH CHECK (current_setting('app.allow_unscoped_access', true) = 'true'
    OR company_id = (NULLIF(current_setting('app.current_company_id', true), ''))::uuid);
ALTER TABLE "custom_field_definitions" FORCE ROW LEVEL SECURITY;
