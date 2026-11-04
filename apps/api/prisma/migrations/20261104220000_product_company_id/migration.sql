-- Products get an owning tenant (#241), expand step. The column stays nullable
-- until the backfill has been verified on a staging copy; the contract step then
-- makes it required, product codes unique per company, and adds RLS on products.

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "company_id" UUID;

-- CreateIndex
CREATE INDEX "products_company_id_idx" ON "products"("company_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Sets company_id on products that do not have one yet:
--   1. products stocked in plants of exactly one company get that company;
--   2. products with no plant at all get their creator's company.
-- Products stocked in plants of more than one company are left NULL for a
-- decision (split or reassign) and counted, as are products it cannot place.
-- Safe to re-run: it only touches rows where company_id is NULL.
--
-- product_plants, shops and users have forced RLS, so the function enables
-- unscoped access for its own statements and then restores the previous value,
-- so it never leaves a caller's transaction unscoped.
CREATE OR REPLACE FUNCTION products_backfill_company_id()
RETURNS TABLE (assigned bigint, multi_company bigint, unplaced bigint)
LANGUAGE plpgsql AS $$
DECLARE
  previous text := current_setting('app.allow_unscoped_access', true);
  from_plants bigint;
  from_creator bigint;
BEGIN
  PERFORM set_config('app.allow_unscoped_access', 'true', true);

  WITH owners AS (
    SELECT pp.product_id,
           (array_agg(DISTINCT s.company_id))[1] AS company_id,
           count(DISTINCT s.company_id) AS companies
    FROM product_plants pp
    JOIN shops s ON s.id = pp.shop_id
    WHERE s.company_id IS NOT NULL
    GROUP BY pp.product_id
  )
  UPDATE products p
  SET company_id = o.company_id
  FROM owners o
  WHERE p.id = o.product_id AND o.companies = 1 AND p.company_id IS NULL;
  GET DIAGNOSTICS from_plants = ROW_COUNT;

  UPDATE products p
  SET company_id = s.company_id
  FROM users u
  JOIN shops s ON s.id = u.shop_id
  WHERE p.company_id IS NULL
    AND p.created_by = u.id
    AND s.company_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM product_plants pp WHERE pp.product_id = p.id);
  GET DIAGNOSTICS from_creator = ROW_COUNT;

  assigned := from_plants + from_creator;
  SELECT count(*) INTO multi_company
  FROM products p
  WHERE p.company_id IS NULL
    AND (SELECT count(DISTINCT s.company_id)
         FROM product_plants pp JOIN shops s ON s.id = pp.shop_id
         WHERE pp.product_id = p.id AND s.company_id IS NOT NULL) > 1;
  SELECT count(*) - multi_company INTO unplaced FROM products WHERE company_id IS NULL;

  PERFORM set_config('app.allow_unscoped_access', coalesce(previous, ''), true);
  RETURN NEXT;
END $$;

SELECT * FROM products_backfill_company_id();
