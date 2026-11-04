# SoftDigit IMS — Business Templates Technical Specification

**Date:** 2026-11-04
**Author:** Architecture Team
**Status:** Draft — pending review
**Parent spec:** `2026-11-03-enterprise-customization-spec.md` (Phase 7 expansion)

---

## 0. Summary

Business templates are reusable, versioned configuration presets that
configure the existing tenant configuration engine for a specific
industry. A new tenant picks a template during onboarding; a SoftDigit
admin can apply one to any tenant from the admin dashboard. Templates
are starting points — once applied, the tenant's configuration is fully
customizable through the normal draft/publish flow.

**Core principle:** Templates produce configuration, not behaviour.
Every template goes through the same draft → validate → publish pipeline
that manual configuration does. No industry-specific conditionals in
application code.

---

## 1. Design Decisions

### 1.1 Templates Are Code, Not Database Rows

Templates live as JSON files in `apps/api/src/common/config/templates/`.
They are reviewed in PRs, versioned with the codebase, and validated in
CI against the module registry and its Zod schemas. This means:

- A template can never reference a module key that doesn't exist.
- A template's config values are always valid per the module's `configSchema`.
- Adding or changing a template goes through code review.

### 1.2 Templates Only Configure What the Engine Supports

Each proposed template capability is classified as:

| Status | Meaning |
|---|---|
| **Supported** | Existing functionality — template enables/configures it |
| **Configurable** | Achievable through the config engine (labels, mandatory fields, enable/disable) |
| **Requires new product work** | Cannot be delivered by a template alone |

A template must never claim to deliver functionality that requires new
product work. If a future product feature (e.g. serial number tracking,
recipe management) is built, the template can be updated to configure it.

### 1.3 The Module Registry Remains Authoritative

- Templates reference only keys present in `MODULE_REGISTRY`.
- Template config values are validated against each module's `configSchema`.
- Plan entitlements are checked at publish time — a template cannot enable
  a module the tenant's plan forbids.
- An omitted module inherits its registry default. Omission does NOT mean
  disabled. A template must explicitly set `enabled: false` to disable.

### 1.4 GST and Compliance Are Separate Concerns

Tax configuration (GSTIN, tax rates, HSN codes, e-invoicing) is
jurisdiction-specific and tenant-specific. Templates do not carry tax
settings. These remain in the existing company settings and product
master data.

---

## 2. Template Data Model

### 2.1 Schema

```typescript
// apps/api/src/common/config/templates/template.schema.ts

interface BusinessTemplate {
  key: string;                    // e.g. 'retail', 'manufacturing'
  version: number;                // bumped on every change to this template
  schemaVersion: number;          // template format version (currently 1)

  metadata: {
    label: string;                // "Retail & POS"
    description: string;          // 1-2 sentence pitch shown in picker
    icon: string;                 // icon key for the template picker UI
    industry: string;             // grouping label: "Retail", "Manufacturing", etc.
    tags: string[];               // searchable: ["pos", "shop", "b2c"]
  };

  compatibility: {
    minConfigSchemaVersion: number; // minimum snapshot schemaVersion this template targets
  };

  configuration: {
    // Module enable/disable and settings (validated against MODULE_REGISTRY)
    modules: Partial<Record<ModuleKey, {
      enabled: boolean;
      config?: Partial<ModuleSettings>;   // mandatory/hidden fields, labels
    }>>;

    // Category seeds — default product categories for this industry
    categories?: CategorySeed[];

    // Custom field seeds — pre-defined custom fields (Phase 5+)
    customFields?: Record<ModuleKey, CustomFieldSeed[]>;
  };
}

interface CategorySeed {
  name: string;
  children?: CategorySeed[];       // up to 2 levels
}

interface CustomFieldSeed {
  fieldKey: string;                 // ^[a-z][a-z0-9_]{1,39}$
  label: string;
  fieldType: 'text' | 'number' | 'date' | 'boolean' | 'select' | 'multiselect';
  options?: { value: string; label: string }[];
  required: boolean;
  searchable: boolean;
}
```

### 2.2 Example Template File

`apps/api/src/common/config/templates/retail.json`:

```json
{
  "key": "retail",
  "version": 1,
  "schemaVersion": 1,
  "metadata": {
    "label": "Retail & POS",
    "description": "For retail shops, multi-store chains, and point-of-sale businesses. Optimized for sales, invoicing, and customer management.",
    "icon": "retail",
    "industry": "Retail",
    "tags": ["pos", "shop", "b2c", "store", "counter-sales"]
  },
  "compatibility": {
    "minConfigSchemaVersion": 1
  },
  "configuration": {
    "modules": {
      "products": {
        "enabled": true,
        "config": { "mandatoryFields": [], "hiddenFields": [], "label": "Products" }
      },
      "customers": {
        "enabled": true,
        "config": { "mandatoryFields": [], "hiddenFields": [] }
      },
      "sales": {
        "enabled": true,
        "config": { "mandatoryFields": [], "hiddenFields": [] }
      },
      "invoices": {
        "enabled": true,
        "config": { "mandatoryFields": [], "hiddenFields": [] }
      },
      "payments": {
        "enabled": true,
        "config": { "mandatoryFields": [], "hiddenFields": [] }
      },
      "barcode-print": {
        "enabled": true,
        "config": { "mandatoryFields": [], "hiddenFields": [] }
      },
      "reports": {
        "enabled": true,
        "config": { "mandatoryFields": [], "hiddenFields": [] }
      },
      "returns": {
        "enabled": true,
        "config": { "mandatoryFields": [], "hiddenFields": [] }
      },
      "rfqs": { "enabled": false },
      "contracts": { "enabled": false },
      "supplier-portal": { "enabled": false },
      "stock-transfers": { "enabled": false },
      "warehouse": { "enabled": false },
      "eway-bills": { "enabled": false }
    },
    "categories": [
      {
        "name": "Electronics",
        "children": [
          { "name": "Mobile Phones" },
          { "name": "Accessories" },
          { "name": "Computers & Laptops" }
        ]
      },
      {
        "name": "Clothing & Apparel",
        "children": [
          { "name": "Men's Wear" },
          { "name": "Women's Wear" },
          { "name": "Kids' Wear" }
        ]
      },
      { "name": "Groceries" },
      { "name": "Home & Kitchen" },
      { "name": "Stationery" },
      { "name": "General Merchandise" }
    ]
  }
}
```

### 2.3 Validation Rules (CI-enforced)

Every template file is validated at build time:

1. `key` matches the filename (without `.json`).
2. Every module key in `configuration.modules` exists in `MODULE_REGISTRY`.
3. Every module's `config` parses against that module's `configSchema.partial()`.
4. `categories` names are non-empty, unique within their level.
5. `customFields` field keys follow `^[a-z][a-z0-9_]{1,39}$` and types are valid.
6. `schemaVersion` and `compatibility.minConfigSchemaVersion` are recognized.
7. No two template files share the same `key`.

---

## 3. Three Kinds of Versioning

These are independent and must not be conflated:

| Concept | What it tracks | Where it lives |
|---|---|---|
| **Template version** (`version`) | Changes to a specific template's content | In the template JSON file |
| **Template schema version** (`schemaVersion`) | Changes to the template format itself | In the template JSON file; migration functions in code |
| **Tenant config version** (`ConfigVersion.version`) | Published configuration snapshots per tenant | In the database (existing) |

### 3.1 Template Provenance

When a template is applied, the resulting `ConfigVersion` records where it
came from:

```typescript
// Inside the published snapshot's metadata
{
  sourceTemplate?: {
    key: string;
    version: number;
    schemaVersion: number;
    appliedAt: string;       // ISO timestamp
    appliedBy: string;       // userId
  }
}
```

A code release that updates a built-in template does NOT automatically
modify existing tenants. Tenants only receive template changes through
explicit reapplication by a SoftDigit admin.

---

## 4. Template Application Service

### 4.1 Application Modes

| Mode | When | Behaviour |
|---|---|---|
| **Initial setup** | New tenant, no `ConfigVersion` exists | Apply template over registry defaults. All template settings become the draft. |
| **Reapplication** | Tenant has existing config | Merge template into current draft. Tenant customizations on modules NOT in the template are preserved. Modules in the template overwrite draft values for those modules. |

### 4.2 Application Logic

```
TemplateService.applyToDraft(companyId, templateKey, mode):

  1. Load template JSON; validate against registry.
  2. Check tenant plan entitlements:
     - For each module the template enables, verify planAllowsFeature().
     - Collect violations; return 422 with the list if any.
  3. If mode == 'initial':
     - Clear any existing draft rows for this company.
     - For each module in template.modules:
       - Insert TenantModuleConfig draft row.
  4. If mode == 'reapplication':
     - For each module in template.modules:
       - Upsert TenantModuleConfig draft row (template values win).
     - Draft rows for modules NOT in the template are untouched.
  5. If template has categories:
     - Stage category seeds (deduplicated against existing categories).
  6. If template has customFields (Phase 5+):
     - Stage custom field definitions (skip if fieldKey already exists).
  7. Return { draftModules, categoriesStaged, diff }.
     // Does NOT publish — caller decides.
```

### 4.3 What Happens on Reapplication

| Concern | Behaviour |
|---|---|
| Modules the template enables | Draft updated to template values |
| Modules the template disables | Draft updated to disabled |
| Modules NOT in the template | Draft unchanged (tenant customizations preserved) |
| Category seeds | Only new categories are added; existing ones are not renamed or deleted |
| Custom fields | Only new field keys are added; existing definitions are not modified |
| Existing number formats | Preserved unless the template explicitly sets them |
| Existing workflows | Untouched — templates do not currently carry workflow overrides |

### 4.4 Concurrency

`applyToDraft` acquires the same `pg_advisory_xact_lock(hash(companyId))`
that `ConfigPublishService.publish` uses. Two concurrent applications for
the same company are serialized.

---

## 5. API Contracts

### 5.1 Template Library (public, no auth required for listing)

```
GET  /api/v1/templates
  → { templates: TemplateSummary[] }
  // TemplateSummary: key, metadata.label, metadata.description,
  //   metadata.icon, metadata.industry, metadata.tags

GET  /api/v1/templates/:key
  → TemplateDetail (full template minus internal fields)
```

### 5.2 Onboarding (authenticated, own company)

```
POST /api/v1/onboarding/apply-template
  body: { templateKey: string }
  → { version: number }
  // Lifecycle:
  //   1. Validate template against registry + tenant plan
  //   2. Apply to draft (mode: initial)
  //   3. Validate draft (same as ConfigPublishService.publish step 3-5)
  //   4. Publish as version 1 — transactional with onboarding
  //   5. Return published version number
```

### 5.3 Admin Application (platform admin)

```
POST /api/v1/platform/tenants/:companyId/draft/apply-template
  body: { templateKey: string }
  → { draftModules, categoriesStaged, diff }
  // Loads into draft only. Admin must preview and publish separately.
  // Uses existing preview/publish endpoints from §8.1 of parent spec.
```

### 5.4 Template Provenance

```
GET  /api/v1/platform/tenants/:companyId/versions/:v
  → ConfigVersion (existing) — snapshot now includes sourceTemplate metadata
```

---

## 6. Business Templates Library

### 6.1 Capability Classification

Before listing templates, classify what each industry needs:

| Capability | Status | Notes |
|---|---|---|
| Enable/disable modules | **Supported** | Core config engine |
| Mandatory/hidden fields | **Supported** | Per-module configSchema |
| Module label renaming | **Supported** | `label` in ModuleSettings |
| Category seeds | **Configurable** | Template applies default categories |
| Custom field seeds | **Configurable** | Phase 5+ only |
| Serial number tracking | **Requires new product work** | Not a config toggle |
| Recipe/BOM management | **Requires new product work** | Needs a recipe module |
| Product variants (size/color) | **Requires new product work** | Needs variant model |
| Batch/expiry tracking | **Requires new product work** | Needs batch model |
| Warranty lifecycle | **Requires new product work** | Needs warranty module |

### 6.2 The 12 Templates

**Release order:** Retail first (validates the engine against real
customers), then Wholesale, Manufacturing, and the rest as their required
capabilities become available.

#### Wave 1 — Retail focus (initial release)

##### 1. Retail & POS (`retail`)

**Industry:** Retail
**Focus:** Sales-driven. Counter sales, invoicing, customer management, returns.

| Module | Enabled | Config |
|---|---|---|
| products | yes | — |
| customers | yes | — |
| sales | yes | — |
| invoices | yes | — |
| payments | yes | — |
| barcode-print | yes | — |
| returns | yes | — |
| reports | yes | — |
| rfqs | **no** | — |
| contracts | **no** | — |
| supplier-portal | **no** | — |
| stock-transfers | **no** | — |
| warehouse | **no** | — |
| eway-bills | **no** | — |

**Categories:** Electronics, Clothing & Apparel (Men's/Women's/Kids'),
Groceries, Home & Kitchen, Stationery, General Merchandise.

##### 2. Wholesale & Distribution (`wholesale`)

**Industry:** Wholesale
**Focus:** Buy and sell in bulk. Both procurement and sales sides active.

| Module | Enabled | Config |
|---|---|---|
| products | yes | — |
| suppliers | yes | — |
| customers | yes | — |
| purchase-orders | yes | — |
| goods-receipts | yes | — |
| goods-issues | yes | — |
| sales | yes | — |
| invoices | yes | — |
| eway-bills | yes | — |
| reports | yes | — |
| supplier-portal | **no** | — |
| rfqs | **no** | — |

**Categories:** FMCG, Electronics, Hardware, Textiles, Stationery,
Chemicals, Food & Beverages.

#### Wave 2 — Manufacturing & procurement

##### 3. Manufacturing (`manufacturing`)

**Industry:** Manufacturing
**Focus:** Raw materials procurement, production, warehouse management.

| Module | Enabled | Config |
|---|---|---|
| products | yes | label: "Materials & Products" |
| suppliers | yes | — |
| purchase-orders | yes | — |
| goods-receipts | yes | — |
| warehouse | yes | — |
| stock-transfers | yes | — |
| contracts | yes | — |
| approvals | yes | — |
| reports | yes | — |
| sales-quotations | **no** | — |
| eway-bills | **no** | — |

**Categories:** Raw Materials, Semi-Finished Goods, Finished Goods,
Packaging Materials, Consumables, Spare Parts.

**Note:** Full BOM/recipe management requires new product work and is
out of scope for this template. The template configures what the current
system supports.

##### 4. Construction Materials (`construction`)

**Industry:** Construction
**Focus:** Bulk materials, approvals, e-way bills for transport.

| Module | Enabled | Config |
|---|---|---|
| products | yes | label: "Materials" |
| suppliers | yes | — |
| purchase-orders | yes | — |
| goods-receipts | yes | — |
| stock-transfers | yes | — |
| eway-bills | yes | — |
| approvals | yes | — |
| reports | yes | — |
| sales-quotations | **no** | — |
| supplier-portal | **no** | — |

**Categories:** Cement, Steel & Iron, Bricks & Blocks, Sand & Aggregates,
Plumbing, Electrical, Paint & Finishes, Tiles & Flooring, Wood & Timber.

#### Wave 3 — Industry-specific

##### 5. Restaurant & F&B (`restaurant`)

**Industry:** Food & Beverage
**Focus:** Ingredient procurement, simple sales/invoicing.

| Module | Enabled | Config |
|---|---|---|
| products | yes | label: "Menu Items & Ingredients" |
| suppliers | yes | label: "Vendors" |
| purchase-orders | yes | — |
| goods-receipts | yes | — |
| invoices | yes | — |
| reports | yes | — |
| rfqs | **no** | — |
| contracts | **no** | — |
| warehouse | **no** | — |
| stock-transfers | **no** | — |
| supplier-portal | **no** | — |

**Categories:** Vegetables & Fruits, Dairy, Meat & Poultry, Spices &
Seasonings, Beverages, Dry Goods, Packaging.

**Note:** Recipe/ingredient management, wastage tracking, and preparation
workflows require new product work.

##### 6. Pharmacy & Healthcare (`pharmacy`)

**Industry:** Healthcare
**Focus:** Procurement, sales, returns. Strict tracking requirements.

| Module | Enabled | Config |
|---|---|---|
| products | yes | label: "Medicines & Supplies" |
| suppliers | yes | — |
| customers | yes | label: "Patients & Institutions" |
| purchase-orders | yes | — |
| goods-receipts | yes | — |
| sales | yes | — |
| invoices | yes | — |
| returns | yes | — |
| barcode-print | yes | — |
| reports | yes | — |
| rfqs | **no** | — |
| contracts | **no** | — |
| supplier-portal | **no** | — |

**Categories:** Tablets & Capsules, Syrups & Liquids, Injections,
Surgical Supplies, OTC Products, Ayurvedic & Herbal, Baby Care,
Personal Care.

**Note:** Batch/expiry tracking and drug schedule compliance require
new product work. This template configures the procurement and sales
flow only.

##### 7. Electronics & IT (`electronics`)

**Industry:** Electronics
**Focus:** Product catalogue, sales, barcode labelling.

| Module | Enabled | Config |
|---|---|---|
| products | yes | — |
| suppliers | yes | — |
| customers | yes | — |
| purchase-orders | yes | — |
| goods-receipts | yes | — |
| sales | yes | — |
| invoices | yes | — |
| barcode-print | yes | — |
| reports | yes | — |
| contracts | **no** | — |

**Categories:** Computers & Laptops, Mobile Phones, Networking Equipment,
Cables & Connectors, Components, Peripherals, Software Licenses, Spare
Parts.

**Note:** Serial number tracking and warranty lifecycle require new
product work.

##### 8. Textiles & Garments (`textiles`)

**Industry:** Textiles
**Focus:** Sales quotations for custom orders, procurement, invoicing.

| Module | Enabled | Config |
|---|---|---|
| products | yes | — |
| suppliers | yes | — |
| customers | yes | — |
| purchase-orders | yes | — |
| goods-receipts | yes | — |
| sales-quotations | yes | — |
| sales | yes | — |
| invoices | yes | — |
| reports | yes | — |
| warehouse | **no** | — |
| stock-transfers | **no** | — |

**Categories:** Cotton Fabrics, Silk, Synthetic, Readymade Garments
(Men's/Women's/Kids'), Accessories & Trims, Dyeing Materials.

**Note:** Product variants (size, color, fabric type) require new
product work.

##### 9. Auto Parts & Spares (`auto-parts`)

**Industry:** Automotive
**Focus:** Parts catalogue, warehouse bin-level tracking, returns.

| Module | Enabled | Config |
|---|---|---|
| products | yes | label: "Parts & Spares" |
| suppliers | yes | — |
| customers | yes | — |
| purchase-orders | yes | — |
| goods-receipts | yes | — |
| sales | yes | — |
| invoices | yes | — |
| warehouse | yes | — |
| barcode-print | yes | — |
| returns | yes | — |
| reports | yes | — |
| rfqs | **no** | — |
| contracts | **no** | — |

**Categories:** Engine Parts, Electrical, Body Parts, Suspension &
Steering, Brakes, Filters, Lubricants & Fluids, Tyres & Tubes, Two-
Wheeler Parts.

##### 10. Agriculture & Agri-Business (`agriculture`)

**Industry:** Agriculture
**Focus:** Produce procurement from farmers, sales, basic invoicing.

| Module | Enabled | Config |
|---|---|---|
| products | yes | label: "Produce & Inputs" |
| suppliers | yes | label: "Farmers & Vendors" |
| customers | yes | — |
| purchase-orders | yes | — |
| goods-receipts | yes | — |
| sales | yes | — |
| invoices | yes | — |
| reports | yes | — |
| contracts | **no** | — |
| supplier-portal | **no** | — |
| warehouse | **no** | — |

**Categories:** Grains & Cereals, Pulses, Oilseeds, Fruits, Vegetables,
Spices, Fertilizers, Pesticides, Seeds.

##### 11. FMCG & Consumer Goods (`fmcg`)

**Industry:** FMCG
**Focus:** High-volume distribution. Full buy-sell-distribute cycle.

| Module | Enabled | Config |
|---|---|---|
| products | yes | — |
| suppliers | yes | — |
| customers | yes | — |
| purchase-orders | yes | — |
| goods-receipts | yes | — |
| goods-issues | yes | — |
| sales | yes | — |
| invoices | yes | — |
| eway-bills | yes | — |
| stock-transfers | yes | — |
| reports | yes | — |
| supplier-portal | **no** | — |

**Categories:** Personal Care, Home Care, Food & Beverages, Health &
Wellness, Baby Products, Confectionery, Dairy, Frozen Foods.

##### 12. E-Commerce & Online Retail (`ecommerce`)

**Industry:** E-Commerce
**Focus:** Order fulfillment, returns, barcode/label printing.

| Module | Enabled | Config |
|---|---|---|
| products | yes | — |
| customers | yes | — |
| sales | yes | — |
| invoices | yes | — |
| goods-issues | yes | — |
| returns | yes | — |
| barcode-print | yes | — |
| payments | yes | — |
| reports | yes | — |
| rfqs | **no** | — |
| contracts | **no** | — |
| supplier-portal | **no** | — |
| approvals | **no** | — |

**Categories:** Fashion, Electronics, Home & Living, Books & Stationery,
Health & Beauty, Sports & Outdoors, Toys & Games.

---

## 7. Onboarding Flow

### 7.1 User-Facing Experience

After company creation (existing signup flow), a new step appears:

```
┌──────────────────────────────────────────────────────────────┐
│           Choose Your Business Type                          │
│                                                              │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐        │
│  │ 🏪      │  │ 📦      │  │ 🏭      │  │ 🍽️     │        │
│  │ Retail  │  │Wholesale│  │ Mfg     │  │ F&B     │        │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘        │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐        │
│  │ 💊      │  │ 💻      │  │ 👔      │  │ 🔧      │        │
│  │Pharmacy │  │ Elec    │  │Textiles │  │AutoParts│        │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘        │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐        │
│  │ 🏗️     │  │ 🌾      │  │ 📱      │  │ 🛒      │        │
│  │Construc │  │ Agri    │  │ FMCG    │  │E-Commerc│        │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘        │
│                                                              │
│  [ Start from Scratch ]           Templates are starting     │
│                                   points — customize anytime │
└──────────────────────────────────────────────────────────────┘
```

### 7.2 Onboarding Lifecycle

1. User selects a template (or "Start from Scratch").
2. Frontend calls `POST /api/v1/onboarding/apply-template`.
3. Backend:
   a. Validates template against registry + tenant plan.
   b. Applies to draft (mode: initial).
   c. Validates the full draft (same pipeline as publish).
   d. Publishes as `ConfigVersion` version 1.
   e. If categories are seeded, inserts them.
   f. Returns `{ version: 1 }`.
4. "Start from Scratch" skips the template call; the tenant gets registry
   defaults (no `ConfigVersion` — existing behaviour).

The entire onboarding template application is **transactional**. If
publish validation fails (should not happen with reviewed templates), the
tenant falls back to registry defaults and the error is logged for the
engineering team.

---

## 8. Admin Dashboard Pages

### 8.1 Template Library Page (`TemplatesPage.tsx`)

- Grid of all available templates with icon, name, description, industry
- Click to view full template details (modules, categories, notes)
- "Apply to Tenant" button → select tenant → generates draft + diff

### 8.2 Apply Template Flow (within `TenantDetailPage.tsx`)

1. Admin selects "Apply Template" from the tenant detail page
2. Picks a template from the library
3. Sees a diff preview: what will change vs. current config
4. Review categories that will be seeded
5. Admin publishes through the existing publish flow

### 8.3 Template Provenance (within `VersionsPage.tsx`)

- Version history shows which versions were created from templates
- `sourceTemplate` metadata displayed: template name, version, who applied

---

## 9. Implementation Plan

### Phase 7 Workstreams (replaces the brief §5.5 in parent spec)

#### 7.1 Template Schema & Registry Integration

- Define `BusinessTemplate` TypeScript interface
- Zod validation schema for template JSON files
- CI validation: every template file validated against module registry
- Template loader service: reads and caches template files from disk

#### 7.2 Built-In Template Library

- Create `apps/api/src/common/config/templates/` directory
- Write `retail.json` first (Wave 1)
- Write `wholesale.json` (Wave 1)
- Category seeds per template
- Template metadata for the picker UI

#### 7.3 Template Application Service

- `TemplateService.applyToDraft(companyId, templateKey, mode)`
- Plan entitlement checks before application
- Initial setup mode (clear + apply)
- Reapplication mode (merge, preserving unrelated customizations)
- Category seeding with deduplication
- Concurrency: `pg_advisory_xact_lock(hash(companyId))`
- Template provenance in snapshot metadata

#### 7.4 Configuration Diff & Preview

- Diff between "current config" and "config after template application"
- Show added, changed, and removed settings
- Show categories that will be seeded
- Reuse existing `ConfigPublishService` diff logic

#### 7.5 Onboarding Template Picker

- `GET /api/v1/templates` endpoint (public listing)
- `GET /api/v1/templates/:key` endpoint (detail)
- `POST /api/v1/onboarding/apply-template` endpoint
- Transactional: validate → draft → publish → seed categories
- Frontend: template picker component in onboarding flow
- "Start from Scratch" option (skips template)

#### 7.6 Admin Template Application

- `POST /api/v1/platform/tenants/:companyId/draft/apply-template`
- Loads into draft only — admin previews and publishes separately
- Admin template library page
- Apply flow with diff preview within tenant detail

#### 7.7 Provenance & Version Management

- `sourceTemplate` metadata in `ConfigVersion` snapshots
- Template version displayed in admin version history
- Template compatibility checks (`minConfigSchemaVersion`)

#### 7.8 Testing

- Unit: template validation against registry (every template file)
- Unit: application service — initial mode, reapplication mode
- Unit: plan entitlement rejection
- Integration: onboarding end-to-end (pick template → published config)
- Integration: admin apply → preview → publish
- Integration: reapplication preserves unrelated customizations
- Isolation: applying a template to Company A does not affect Company B
- Concurrency: two simultaneous applications for one company → one succeeds
- Regression: "Start from Scratch" produces same result as today

---

## 10. Release Order

| Wave | Templates | Prerequisite |
|---|---|---|
| 1 | Retail, Wholesale | Config engine (Phase 1-2), onboarding UI (Phase 4) |
| 2 | Manufacturing, Construction | Phase 1-4 complete |
| 3 | Restaurant, Pharmacy, Electronics, Textiles, Auto Parts, Agriculture, FMCG, E-Commerce | Phase 5 for custom field seeds |

**Start with Retail.** It validates the template engine against the first
real customer workflow. Only after Retail is production-proven should the
remaining templates be written.

---

## 11. Out of Scope

- **Tenant config export as reusable template** — requires sanitization
  of tenant data, IDs, and sequence counters. Deferred to a later phase.
- **Template marketplace or user-created templates** — templates are
  SoftDigit-maintained code.
- **Automatic template updates for existing tenants** — code releases
  that update templates do not affect existing tenants.
- **Workflow seeds in templates** — workflow configuration (Phase 6) is
  complex enough that it should be applied per-tenant, not templated.
- **Number format configuration** — no numbering system exists yet.
  When built, templates can be updated to include format preferences.
- **Capabilities requiring new product work** (serial tracking, recipes,
  variants, batch/expiry, warranty lifecycle) — these are product
  roadmap items, not template concerns.

---

## 12. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Template promises functionality that doesn't exist | High | High | Capability classification (§6.1); CI validates against registry |
| Template breaks on registry schema change | Medium | High | CI validation catches; `minConfigSchemaVersion` compatibility check |
| Reapplication loses tenant customizations | Medium | Critical | Explicit merge semantics (§4.3); diff preview before publish |
| Plan mismatch: template enables gated module | Medium | Medium | Plan entitlement check at application time |
| Category seeds create duplicates | Low | Low | Deduplication by name |
| Too many templates to maintain | Medium | Medium | Wave-based release; only maintain templates with real customer demand |

---

*This specification must be approved before implementation begins. It
expands Phase 7 of the parent enterprise customization spec.*
