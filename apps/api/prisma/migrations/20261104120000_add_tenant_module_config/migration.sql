-- CreateTable
CREATE TABLE "tenant_module_configs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "shop_id" UUID,
    "module_key" TEXT NOT NULL,
    "enabled" BOOLEAN,
    "config" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "tenant_module_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_module_configs_company_id_idx" ON "tenant_module_configs"("company_id");

-- A plain unique constraint would treat NULL shop_id values as distinct and allow
-- duplicate company-wide rows; NULLS NOT DISTINCT (Postgres 15+) closes that gap.
CREATE UNIQUE INDEX "tenant_module_configs_scope_key"
    ON "tenant_module_configs" ("company_id", "shop_id", "module_key") NULLS NOT DISTINCT;

-- AddForeignKey
ALTER TABLE "tenant_module_configs" ADD CONSTRAINT "tenant_module_configs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_module_configs" ADD CONSTRAINT "tenant_module_configs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
