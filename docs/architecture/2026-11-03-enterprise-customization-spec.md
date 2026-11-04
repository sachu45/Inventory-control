# SoftDigit IMS — Enterprise Customization Technical Architecture Specification

**Date:** 2026-11-03 (revised 2026-11-04)
**Author:** Architecture Team
**Status:** Draft — Revision 2, pending review

---

## 0. Revision Log

**Revision 2 (2026-11-04)** — addresses the architecture review on PR #174.
This version supersedes the partial reconciliation merged in PR #182, which kept
the five-level merge, the undefined `role_ui_overrides` table, `/admin/tenants`,
`/me/sidebar` and `UserConfigOverride`. Its additions (guard execution order,
API-level field enforcement, custom field lifecycle) are covered in §9.1, §9.2
and §4.5. GitHub issues #147–#185 are written against this version.

| Change | Section |
|---|---|
| Business configuration, authorization and personal preferences are now three separate layers. Removed the role/user levels from config merging. | §3.1 |
| Versioning moved from Phase 7 to Phase 1. Runtime reads only immutable published snapshots; drafts are never live. Rollback creates a new version. | §4.3, §5.3 |
| Cache redesigned around versioned snapshots (version in key, no TTL-based invalidation, single-flight, Redis-down fallback). | §5.2 |
| Module registry gains `dependsOn` and a per-module config schema; publish validates both. | §4.1, §5.3 |
| Custom fields: backend validation, field lifecycle rules, field permissions, indexing strategy. Model stays in Phase 5. | §4.5 |
| Module config (mandatory fields etc.) is enforced at the API, not only in the UI. | §9.2 |
| Workflow admin is an interface over the existing engines; no new engine, no arbitrary expressions. | §5.6 |
| Tests are written in every phase; Phase 8 is final validation and pilot. | §11, §12 |
| "Production-ready" claims replaced with "Exists — verify"; Phase 1 includes a verification task. | §2.1 |

**Fixed inconsistencies in Revision 1:**
- The resolver read a `role_ui_overrides` table that no model defined. Role-specific visibility is now handled by field permissions (§4.5, §9.2).
- `@@unique([companyId, shopId, moduleKey])` does not stop duplicate company-wide rows, because Postgres treats NULLs as distinct. Fixed with `NULLS NOT DISTINCT` (§4.2).
- The spec said `/me/sidebar` and `/admin/...` while the issues said `/me/config` and `/platform/...`. Unified on `/me/config` and the existing `platform/` prefix (§8).
- Performance targets disagreed (spec: p99 <5ms; issue #173: p95 <50ms). They measure different things; both are now stated explicitly (§12).
- "Three new tables for Phase 1-2" included `CustomFieldDefinition`, which belongs to Phase 5.

**Review suggestions not adopted:**
- *Cache keys containing `roleId`, `userId`, `moduleKey` and version.* This would create one cache entry per user per module and make invalidation a fan-out problem. Business config does not vary by role or user (§3.1), so the cache is one immutable snapshot per company version, plus a small per-user preferences entry. The version is still in the key, which is what the review's concern needs.

---

## 1. Executive Summary

Scale the existing SoftDigit IMS from a subscription-tiered SaaS into a
customizable enterprise IMS platform where **each module's behaviour, visibility,
fields, workflows and branding are configurable per tenant** from an internal
SoftDigit admin dashboard — without forking the codebase.

**Core principle:** One codebase, one deployment. Every ₹10L client gets a
tailored experience through configuration, not code branches.

**Build order principle:** The configuration engine (data contracts, publish
lifecycle, validation, security boundaries, tests) is the product foundation.
The admin dashboard is only an interface to it and comes after the engine.

---

## 2. Current Architecture Assessment

### 2.1 What Already Exists (Reuse — Don't Rebuild)

"Exists" means the code is present. Each item's behaviour and test coverage must
be verified before the new layer depends on it (Phase 1 task, §11).

| Capability | Location | Status |
|---|---|---|
| Multi-tenant isolation | `apps/api/src/common/tenant/tenant-rls.interceptor.ts` + `tenant-context.ts` — AsyncLocalStorage with `companyId` scoping | Exists — verify |
| Per-company feature flags | `apps/api/src/common/workflow-engine/ops/feature-flags.service.ts` — Redis-cached, env fallback, per-company overrides via `NotificationPolicy` | Exists — verify |
| Role-based permissions | `apps/api/src/common/auth/role-permissions.ts` — per-company overrides stored in `system_settings`, `resource:action` format | Exists — verify |
| Subscription plan gating | `apps/api/src/common/plans/plan-config.ts` — TRIAL/PRO/PLUS with `planAllowsFeature()` and `PLAN_LIMITS` | Exists — verify |
| Subscription write guard | `apps/api/src/modules/billing/guards/subscription-write.guard.ts` — expired plans become read-only | Exists — verify |
| Frontend feature gate | `apps/web/src/components/TrialFeatureGate.tsx` — plan-based feature locking with upgrade CTA | Exists |
| Policy engine | `apps/api/src/common/workflow-engine/policy/` — condition trees, fixed comparators, priority-ordered rules | Exists — verify |
| Workflow engine | `apps/api/src/common/workflow-engine/graph/` — versioned DAG compiler, runtime, thread runner | Exists — verify |
| Branding system | `apps/api/src/common/branding/` — profiles, document branding, media assets per company | Exists — verify |
| Platform admin | `apps/api/src/modules/platform/` — `PlatformAdminGuard`, audit service, subscription dashboard (`platform/subscriptions`) | Basic — needs expansion |
| Approval workflows | `apps/api/src/modules/approvals/` | Exists — verify |
| Company settings store | Prisma model `CompanySetting` — key/value per company | Exists |
| System settings store | Prisma model `SystemSetting` — global key/value with JSON | Exists |
| Sidebar navigation | `apps/web/src/lib/sidebar-navigation.ts` — sections with permission gates | Hardcoded — becomes config-driven |

### 2.2 What's Missing (Must Build)

| Capability | Current State |
|---|---|
| Module registry | No concept of "module" as a configurable unit — modules are NestJS classes imported in `app.module.ts` |
| Tenant module configuration | `FeatureFlagsService` covers workflow features only (7 flags), not all 30+ modules |
| Config publish lifecycle | Feature flags are live-on-write; no draft, publish or rollback |
| Config validation | No schema for module settings; no dependency checks between modules |
| Personal UI preferences | None beyond role permissions |
| Custom field definitions | No dynamic field system — all fields are Prisma schema columns |
| Admin dashboard app | No `apps/admin` exists |
| Config-driven sidebar | `SIDEBAR_SECTIONS` is a hardcoded array |
| Per-tenant UI layout config | No way to customize forms, tables, dashboard widgets per company |

### 2.3 Existing Data Model (Key Tables)

**150+ Prisma models** in a 4333-line schema. Postgres 15 (`docker/docker-compose.yml`, CI). Key structural ones for this work:

- `Company` — tenant root, carries subscription fields
- `Shop` — plants/branches within a company
- `StorageLocation` — warehouses within shops
- `User` — belongs to a company, has a `Role`
- `Role` — OWNER/ADMIN/INVENTORY_MANAGER/PURCHASE_MANAGER/SALES/EMPLOYEE/WAREHOUSE_STAFF/VIEWER/VENDOR/SHOP_USER
- `SystemSetting` — global JSON key-value (used for role permission overrides)
- `CompanySetting` — per-company string key-value
- `NotificationPolicy` — reused for feature flags (scope='feature-flag')
- `WorkflowGraph` / `WorkflowVersion` / `WorkflowNode` — versioned workflow definitions
- `BrandingProfile` / `DocumentBranding` / `MediaAsset` — per-company branding

---

## 3. Target Architecture

### 3.1 Three Separate Layers

Revision 1 merged Platform → Company → Shop → Role → User into one config. That
mixed business rules with authorization and personal taste, and let a user
preference override a business requirement. They are now three layers that
never merge into each other:

```
┌──────────────────────────────────────────────────────────────┐
│ 1. BUSINESS CONFIGURATION  (set by SoftDigit admins)          │
│    Platform defaults (MODULE_REGISTRY)                         │
│      └─► Company config     (published snapshot)               │
│            └─► Shop/Plant overrides (same snapshot)            │
│    = resolved business config: modules on/off, mandatory and  │
│      hidden fields, number formats, thresholds, labels         │
├──────────────────────────────────────────────────────────────┤
│ 2. AUTHORIZATION  (existing, unchanged)                        │
│    Plan entitlements (planAllowsFeature)                       │
│    + role permissions (PermissionsGuard, resource:action)      │
│    + field permissions (§4.5)                                  │
│    + resource-level checks in services                         │
├──────────────────────────────────────────────────────────────┤
│ 3. PERSONAL PREFERENCES  (set by each user)                    │
│    Table column order, hidden *optional* columns, default      │
│    sort and filters, sidebar pin/order.                        │
│    Restricted schema. Cannot touch forms, mandatory fields,    │
│    module enablement or anything in layer 1.                   │
└──────────────────────────────────────────────────────────────┘
```

**A feature is usable only when all of these hold:**

```
module enabled in business config
  AND all dependsOn modules enabled
  AND plan allows module.planGate
  AND user has module.requiredPermission
```

Each check is evaluated independently. Config can only *narrow* what plan and
permissions allow; it can never grant access.

**Resolution** (business layer only):

```typescript
resolve(snapshot: PublishedSnapshot, shopId: string | null): ResolvedBusinessConfig {
  // snapshot already contains registry defaults merged with company config,
  // computed once at publish time (§5.3)
  const shop = shopId ? snapshot.shops[shopId] ?? {} : {};
  return mergeShopOverrides(snapshot.company, shop); // only keys the registry marks shopOverridable
}
```

Shop overrides are limited to keys each module's schema marks
`shopOverridable` (e.g. number formats, local thresholds). A shop cannot
disable a mandatory field that the company requires.

### 3.2 System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                     SOFTDIGIT ADMIN (apps/admin)                    │
│  React + Mantine │ PlatformAdminGuard │ Internal SoftDigit team     │
│                                                                     │
│  Tenants │ Module Config │ Draft/Preview/Publish │ Custom Fields     │
│  Workflows │ Branding │ Roles │ Templates │ Audit & Diff            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ REST API (same apps/api, /platform/*)
┌──────────────────────────────▼──────────────────────────────────────┐
│                    CONFIGURATION LAYER (new)                        │
│                                                                     │
│  MODULE_REGISTRY          │ Modules, defaults, schemas, dependencies│
│  ConfigDraftService       │ Edits the draft working set             │
│  ConfigPublishService     │ Validate → compile → immutable snapshot │
│  ConfigResolverService    │ Reads published snapshot (cached)       │
│  UserPreferenceService    │ Personal preferences (restricted)       │
│  CustomFieldService       │ Field definitions + value validation    │
│                                                                     │
│  ── Adapts into existing (no new engines) ──                        │
│  FeatureFlagsService │ PolicyEngine │ WorkflowEngine │ Branding     │
│  SubscriptionService │ PermissionsGuard                             │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                    EXISTING BUSINESS MODULES                        │
│  Products │ PurchaseOrders │ Sales │ Invoices │ Warehouse │ ...     │
│                                                                     │
│  Read config via ConfigResolverService                              │
│  Enforce mandatory/hidden fields + custom fields on writes (§9.2)   │
│  Permissions via existing PermissionsGuard                          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│  PostgreSQL 15 (RLS) │ Redis (snapshot cache) │ BullMQ │ S3 │ Sentry │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Data Contracts

### 4.1 Module Registry (code-defined, not DB)

The registry is a TypeScript constant. Config rows can only reference modules
that exist in code, so config corruption cannot create phantom modules.

**New file:** `apps/api/src/common/config/module-registry.ts`

```typescript
export interface ModuleDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  key: ModuleKey;                    // e.g. 'products', 'purchase-orders'
  label: string;
  description: string;
  sidebarSection: SidebarSectionId;
  sidebarPath: string;
  sidebarIcon: string;               // Icon key from iconMap
  defaultEnabled: boolean;           // Matches today's behaviour (§10)
  planGate: PlanFeature | null;      // Existing plan feature gate
  requiredPermission: string | null; // e.g. 'product:read'
  dependsOn: ModuleKey[];            // Must be enabled for this module to be enabled
  configSchema: S;                   // zod schema for this module's settings
  defaults: z.infer<S>;              // Must parse against configSchema (unit-tested)
  shopOverridable: (keyof z.infer<S>)[]; // Keys a shop may override
  customizableFields: string[];      // Standard fields that can be mandatory/hidden
  lockedMandatoryFields: string[];   // Fields the platform always requires (cannot be hidden)
  supportsCustomFields: boolean;
  supportsWorkflows: boolean;
}

export const MODULE_REGISTRY = {
  'purchase-orders': {
    key: 'purchase-orders',
    label: 'Purchase Orders',
    description: 'Procurement purchase orders',
    sidebarSection: 'procurement',
    sidebarPath: '/purchase-orders',
    sidebarIcon: 'purchaseOrders',
    defaultEnabled: true,
    planGate: 'purchase_orders',
    requiredPermission: 'purchase_order:read',
    dependsOn: ['products', 'suppliers'],
    configSchema: z.object({
      mandatoryFields: z.array(z.enum(['expectedDeliveryDate', 'logistics', 'taxFields', 'lineDescription', 'supplierRef'])),
      hiddenFields: z.array(z.enum(['expectedDeliveryDate', 'logistics', 'taxFields', 'lineDescription', 'supplierRef'])),
      poNumberFormat: z.string().regex(/^[A-Z0-9\-{}:]+$/).max(40),
      maxPoValueWithoutApproval: z.number().int().nonnegative(),
      label: z.string().max(40).optional(),
    }).strict(),
    defaults: { mandatoryFields: [], hiddenFields: [], poNumberFormat: 'PO-{YYYY}-{SEQ:5}', maxPoValueWithoutApproval: 0 },
    shopOverridable: ['poNumberFormat'],
    customizableFields: ['expectedDeliveryDate', 'logistics', 'taxFields', 'lineDescription', 'supplierRef'],
    lockedMandatoryFields: ['supplierId', 'lines'],
    supportsCustomFields: true,
    supportsWorkflows: true,
  },
  // ... one entry per module (all 30+); see issue #158 for the full table
} as const satisfies Record<string, ModuleDefinition>;
```

Schemas use `.strict()` so unknown keys are rejected instead of silently stored.
Approval *levels* are not a module setting; they live in the workflow/policy
layer (§5.6) so there is one source of truth for approvals.

**Registry invariants (unit-tested in CI):**
- `defaults` parses against `configSchema`
- every `dependsOn` key exists in the registry
- the dependency graph has no cycles
- `hiddenFields ∩ lockedMandatoryFields = ∅` is enforced by a schema refinement

### 4.2 Draft Working Set — `TenantModuleConfig`

The rows admins edit. **Never read by tenant requests.** Only the publish step
reads them.

```prisma
model TenantModuleConfig {
  id         String   @id @default(uuid()) @db.Uuid
  companyId  String   @map("company_id") @db.Uuid
  shopId     String?  @map("shop_id") @db.Uuid        // null = company-wide
  moduleKey  String   @map("module_key")
  enabled    Boolean?                                  // null = inherit (shop rows) / registry default
  config     Json     @default("{}")                   // Partial settings; validated against configSchema
  revision   Int      @default(1)                      // Optimistic concurrency for draft edits
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt  DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)
  updatedBy  String?  @map("updated_by") @db.Uuid

  company Company @relation(fields: [companyId], references: [id], onDelete: Cascade)
  shop    Shop?   @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([companyId])
  @@map("tenant_module_configs")
}
```

**Uniqueness:** Prisma's `@@unique([companyId, shopId, moduleKey])` would allow
duplicate company-wide rows because Postgres treats NULLs as distinct. The
migration adds the constraint in raw SQL instead:

```sql
CREATE UNIQUE INDEX tenant_module_configs_scope_key
  ON tenant_module_configs (company_id, shop_id, module_key) NULLS NOT DISTINCT;
```

**Draft writes** use `UPDATE ... WHERE id = $1 AND revision = $2`, incrementing
`revision`. Zero rows updated → `409 Conflict` (another admin edited it).

Each draft write validates the partial `config` against
`configSchema.partial()`. Full validation happens at publish.

### 4.3 Published Snapshots — `ConfigVersion` (Phase 1)

Immutable. The only config source tenant requests ever read.

```prisma
model ConfigVersion {
  id            String   @id @default(uuid()) @db.Uuid
  companyId     String   @map("company_id") @db.Uuid
  version       Int                                    // Monotonic per company, starts at 1
  schemaVersion Int      @map("schema_version")        // Snapshot format version (§4.6)
  snapshot      Json                                   // Fully resolved company + shop config
  sourceVersion Int?     @map("source_version")        // Set when this version is a rollback
  changeNote    String?  @map("change_note")
  publishedBy   String   @map("published_by") @db.Uuid
  publishedAt   DateTime @default(now()) @map("published_at") @db.Timestamptz(6)

  company Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  @@unique([companyId, version])
  @@map("config_versions")
}
```

- **Active version** = the highest `version` for the company. No status column,
  no pointer to keep in sync.
- **Rows are never updated or deleted** (enforced by revoking `UPDATE`/`DELETE`
  on the table from the app role, or a trigger).
- **No snapshot yet** (all existing companies) → resolver uses registry defaults,
  which equal today's behaviour.

Snapshot shape:

```typescript
type PublishedSnapshot = {
  schemaVersion: 1;
  version: number;
  company: Record<ModuleKey, { enabled: boolean; config: ModuleConfig }>; // registry defaults already merged
  shops: Record<ShopId, Partial<Record<ModuleKey, { enabled?: boolean; config: Partial<ModuleConfig> }>>>;
  customFields: Record<ModuleKey, CustomFieldDefinitionSnapshot[]>;       // added in Phase 5
};
```

### 4.4 Personal Preferences — `UserPreference`

Renamed from `UserConfigOverride` so the name says what it is.

```prisma
model UserPreference {
  id         String   @id @default(uuid()) @db.Uuid
  companyId  String   @map("company_id") @db.Uuid
  userId     String   @map("user_id") @db.Uuid
  scope      String                                    // moduleKey, or 'sidebar'
  prefs      Json     @default("{}")
  updatedAt  DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  company Company @relation(fields: [companyId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([companyId, userId, scope])
  @@map("user_preferences")
}
```

`prefs` is validated against a fixed zod schema:
`{ columnOrder?, hiddenColumns?, defaultSort?, defaultFilters?, pinned?, order? }`.
When read, `hiddenColumns` entries that are mandatory in the business config are
dropped, so a preference can never hide what the business requires. Preferences
are not versioned or published; they are the user's own.

### 4.5 Custom Fields (Phase 5)

**Definition model:**

```prisma
model CustomFieldDefinition {
  id            String    @id @default(uuid()) @db.Uuid
  companyId     String    @map("company_id") @db.Uuid
  moduleKey     String    @map("module_key")
  fieldKey      String    @map("field_key")             // Immutable after creation; ^[a-z][a-z0-9_]{1,39}$
  label         String
  fieldType     String    @map("field_type")            // text | number | date | boolean | select | multiselect
  options       Json?                                    // select/multiselect: [{ value, label, archived? }]
  validation    Json?                                    // { min?, max?, maxLength?, pattern? } — fixed vocabulary
  required      Boolean   @default(false)
  defaultValue  Json?     @map("default_value")
  searchable    Boolean   @default(false)               // Appears in list filters
  readRoles     String[]  @map("read_roles")            // Empty = everyone with module read permission
  writeRoles    String[]  @map("write_roles")           // Empty = everyone with module write permission
  sortOrder     Int       @default(0) @map("sort_order")
  archivedAt    DateTime? @map("archived_at") @db.Timestamptz(6)
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  company Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  @@unique([companyId, moduleKey, fieldKey])
  @@map("custom_field_definitions")
}
```

Definitions are edited as drafts and take effect only when published (they are
included in the snapshot).

**Values** go in a `custom_fields Jsonb` column on each supporting table
(`products`, `suppliers`, `customers`, PO/SO/invoice/GR/GI headers). Not EAV.

**Backend validation (mandatory):** every create/update on a supporting entity
validates `custom_fields` against the published definitions. Unknown keys are
rejected, `required` is enforced, types and `validation` rules are checked, and
`writeRoles` is enforced. Frontend validation is a convenience only.

**Lifecycle rules:**

| Change | Allowed? |
|---|---|
| Rename label, reorder, change default | Yes |
| Change `fieldKey` | No — create a new field |
| Change `fieldType` | Only while no record has a value for it |
| Add select option | Yes |
| Remove select option | Archive the option; existing values stay readable |
| Make `required` true | Only with a backfill value, or applies to new/edited records only (admin chooses) |
| Delete field | No — archive. Archived fields are hidden, not validated, values retained |
| Restore archived field | Yes |

**Query/index strategy:**
- One GIN index (`jsonb_path_ops`) per table for equality/containment filters on `searchable` fields.
- Range filters and sorting on a specific field: add an expression index for
  that field on demand (an ops task, measured first). Not automatic.
- Uniqueness of custom field values: out of scope for v1.

**Field permissions** (`readRoles`/`writeRoles`) also cover the need that
Revision 1 tried to meet with role UI overrides: e.g. hide a cost field from
`SALES`. Read filtering happens in the API response, not only in the UI.

### 4.6 Snapshot Schema Migrations

`schemaVersion` identifies the snapshot format. When a module's `configSchema`
changes incompatibly, ship a migration function `migrate_N_to_N+1(snapshot)` in
`apps/api/src/common/config/migrations/`. The resolver upgrades old snapshots in
memory on read; the next publish writes the new format. Existing rows are never
rewritten.

---

## 5. Backend Services

### 5.1 Module Registry Service

`apps/api/src/common/config/module-registry.service.ts` — exposes the registry and
computes availability with the plan:

```typescript
isUsable(mod, snapshot, plan, permissions): boolean {
  const cfg = snapshot.company[mod.key];
  return cfg.enabled
    && mod.dependsOn.every((d) => snapshot.company[d].enabled)
    && (!mod.planGate || planAllowsFeature(plan, mod.planGate))
    && (!mod.requiredPermission || permissions.has(mod.requiredPermission));
}
```

### 5.2 Config Resolver Service and Cache

`apps/api/src/common/config/config-resolver.service.ts`

Because published snapshots are immutable, caching is simple and safe:

| Key | Value | TTL |
|---|---|---|
| `cfg:v1:{companyId}:latest` | latest version number | 5s (also deleted on publish) |
| `cfg:v1:{companyId}:snap:{version}` | snapshot JSON | 24h — immutable, so it never goes stale |
| `cfg:v1:pref:{companyId}:{userId}` | user preferences | 5 min, deleted on write |

- **Read path:** in-process LRU (keyed the same way) → Redis → Postgres.
- **Publish:** commits the new version, then deletes `…:latest`. Every node sees
  the new version within the 5s pointer TTL (immediately on the node that published).
- **Stale writes impossible:** a snapshot key's content never changes, so a slow
  writer can only write the correct content.
- **Stampede:** single-flight per key per process (one in-flight DB load; other
  callers await it).
- **Redis unavailable:** fall through to Postgres (one indexed row read), log a
  metric, keep serving. Never fall back to registry defaults when a snapshot
  exists — that could re-enable modules a tenant disabled.
- **Tenant scoping:** every key starts with `companyId` taken from
  `TenantContext`, never from request input.
- **Provenance (effective-config viewer):** `resolve(..., { explain: true })`
  returns, per key, the layer that set it (registry default / company / shop).
  Admin-only.

### 5.3 Config Draft and Publish Services

`ConfigDraftService` — CRUD on `TenantModuleConfig` with revision checks (§4.2).

`ConfigPublishService.publish(companyId, expectedBaseVersion, note)`:

1. Transaction with `pg_advisory_xact_lock(hash(companyId))` — one publish per company at a time.
2. Check latest version equals `expectedBaseVersion`; otherwise `409` (someone published since the admin previewed).
3. Load drafts, merge with registry defaults, and validate each module against its full `configSchema`.
4. Validate the dependency graph: no enabled module with a disabled `dependsOn`.
5. Validate shop rows only override `shopOverridable` keys.
6. Insert `ConfigVersion` with `version = expectedBaseVersion + 1`.
7. Write audit entry (actor, versions, diff summary).
8. After commit: delete `cfg:v1:{companyId}:latest`.

Validation failures return all errors at once (`422` with a list), not just the first.

**Preview:** `compileDraft(companyId)` runs steps 3–5 without writing and returns
the would-be snapshot plus a diff against the active version. Admins can
resolve it as any user of the company. Nothing a tenant sees changes.

**Rollback(targetVersion):** copies the snapshot of `targetVersion` into a *new*
version with `sourceVersion = targetVersion`, and resets drafts to match it.
History is preserved.

**Diff:** structural JSON diff between any two versions, used by preview, the
audit log and the admin UI.

### 5.4 User-Facing Config Endpoint

`GET /api/v1/me/config` — one call at login/app load:

```typescript
type MeConfigResponse = {
  version: number;                       // also sent as ETag
  modules: Record<ModuleKey, { usable: boolean; label: string; config: ModuleConfig }>;
  sidebar: SidebarSection[];             // server-built: usable modules only, in config order
  preferences: Record<string, UserPrefs>;
};
```

The frontend re-fetches with `If-None-Match`; `304` when the version and
preferences are unchanged. The server builds the sidebar from registry + config
+ plan + permissions, so the client never needs to combine them.

### 5.5 Config Templates and Import/Export (Phase 7)

- **Export:** a published snapshot plus custom field definitions as a JSON file
  with `schemaVersion`. Contains no tenant data or IDs other than module/field keys.
- **Import:** loads the file into the *draft* working set of a target company.
  It still has to be previewed and published. This is how config moves between
  staging and production, and how templates are applied.
- **Templates:** named exports maintained by SoftDigit (e.g. Manufacturing,
  Retail, Wholesale), stored as files in the repo
  (`apps/api/src/common/config/templates/`) so they are reviewed like code.

### 5.6 Workflow and Policy Administration (Phase 6)

No new engine. The admin layer manages the existing engines' data:

- `WorkflowGraph` / `WorkflowVersion` per company, compiled with the existing
  compiler before save; invalid graphs are rejected.
- Policy rules use only the existing condition vocabulary
  (`all`/`any`/`not`, comparators `eq/ne/gt/gte/lt/lte/in`) over a fixed list of
  facts per module. No scripts, no free-form expressions, no executable code.
- Approval chains (e.g. "PO ≥ ₹50,000 also needs Finance") are expressed as
  policy rules + workflow graphs, not as module settings.
- Workflow graphs keep their own existing versioning. Config snapshots reference
  them by graph ID, not by copying them.

---

## 6. Files to Modify (Existing Codebase)

### 6.1 Backend

| File | Change |
|---|---|
| `apps/api/src/app.module.ts` | Import `ConfigModule` |
| `apps/api/prisma/schema.prisma` | Phase 1: `TenantModuleConfig`, `ConfigVersion`, `UserPreference` + relations. Phase 5: `CustomFieldDefinition`, `custom_fields` columns |
| `apps/api/src/common/plans/plan-config.ts` | No change |
| `apps/api/src/common/workflow-engine/ops/feature-flags.service.ts` | No change — keep for workflow flags |
| `apps/api/src/common/auth/role-permissions.ts` | No change |
| `apps/api/src/modules/platform/platform.module.ts` | Import `ConfigAdminModule` |
| Business module write services (PO, SO, products, …) | Phase 4: enforce mandatory/hidden fields; Phase 5: validate custom fields |

### 6.2 Frontend

| File | Change |
|---|---|
| `apps/web/src/lib/sidebar-navigation.ts` | Build from `/me/config` `sidebar`; keep `SIDEBAR_SECTIONS` as fallback |
| `apps/web/src/components/Sidebar.tsx` | Read sidebar from config query |
| `apps/web/src/store/authStore.ts` | Hold `MeConfigResponse` |
| `apps/web/src/components/TrialFeatureGate.tsx` | Also check `modules[key].usable` |

### 6.3 New Files

| File | Purpose |
|---|---|
| `apps/api/src/common/config/module-registry.ts` | Registry constant + types |
| `apps/api/src/common/config/module-registry.service.ts` | Availability checks |
| `apps/api/src/common/config/config-resolver.service.ts` | Snapshot reads + cache |
| `apps/api/src/common/config/config-draft.service.ts` | Draft CRUD |
| `apps/api/src/common/config/config-publish.service.ts` | Validate, publish, preview, rollback, diff |
| `apps/api/src/common/config/user-preference.service.ts` | Preferences |
| `apps/api/src/common/config/migrations/` | Snapshot schema migrations |
| `apps/api/src/common/config/config.module.ts` | Wiring |
| `apps/api/src/modules/config-admin/*` | `/platform/tenants/...` controllers + DTOs |
| `apps/api/src/modules/me-config/*` | `/me/config`, `/me/preferences` |
| `apps/admin/` | Admin dashboard (§7) |

---

## 7. Admin Dashboard Architecture (`apps/admin`)

### 7.1 Tech Stack

Same as `apps/web`: React 18 + TypeScript, Mantine, TanStack Query, React Router, Vite.

### 7.2 Auth

Same JWT auth as `apps/api`. All calls hit `/platform/*`, gated by `PlatformAdminGuard`.

### 7.3 Pages

```
apps/admin/src/pages/
  DashboardPage.tsx        — Tenant count, health, activity
  TenantsPage.tsx          — Companies, subscription status
  TenantDetailPage.tsx     — One company: config, users, billing, audit
  ModuleConfigPage.tsx     — Draft editor (forms generated from configSchema)
  PublishPage.tsx          — Preview, diff vs active, validation errors, publish
  VersionsPage.tsx         — History, diff any two versions, rollback
  EffectiveConfigPage.tsx  — "Why is this value set?" provenance view
  CustomFieldsPage.tsx     — Field definitions per module (Phase 5)
  WorkflowConfigPage.tsx   — Workflow graphs + policy rules (Phase 6)
  BrandingPage.tsx         — Existing branding system
  RolesPermissionsPage.tsx — Role permission overrides
  TemplatesPage.tsx        — Apply template / import / export (Phase 7)
  AuditLogPage.tsx         — All config changes with diffs
```

### 7.4 Module Config Editor

```
┌──────────────────────────────────────────────────────────────────┐
│  Purchase Orders — Acme Manufacturing Ltd        Draft (rev 7)   │
├──────────────────────────────────────────────────────────────────┤
│  Enabled: [✓]        Requires: Products ✓, Suppliers ✓           │
│                                                                  │
│  PO Number Format:        [PO-{YYYY}-{SEQ:5}]   (shop-overridable)│
│  Max PO without approval: [₹1,00,000]                            │
│                                                                  │
│  Mandatory Fields:   [✓] Expected Delivery  [✓] Logistics        │
│  Hidden Fields:      [ ] Supplier Reference                      │
│  Always required:    Supplier, Lines (platform-locked)           │
│                                                                  │
│  Approvals: managed in Workflows → "PO approval" (v3)            │
│                                                                  │
│  [Save Draft]   [Preview & Diff]   [Publish…]                    │
└──────────────────────────────────────────────────────────────────┘
```

Forms are generated from each module's `configSchema`, so adding a setting in
code makes it editable without new admin UI.

---

## 8. API Contracts

All admin routes live under the existing `platform/` prefix and are gated by
`PlatformAdminGuard`. All mutations are audited and rate-limited (existing
`ThrottlerGuard`, stricter limit for `/platform/*`).

### 8.1 Admin APIs

```
# Tenants
GET    /api/v1/platform/tenants
GET    /api/v1/platform/tenants/:companyId

# Draft working set
GET    /api/v1/platform/tenants/:companyId/draft/modules
PUT    /api/v1/platform/tenants/:companyId/draft/modules/:key          # body: { enabled?, config, revision }
DELETE /api/v1/platform/tenants/:companyId/draft/modules/:key          # reset to registry default
PUT    /api/v1/platform/tenants/:companyId/draft/shops/:shopId/modules/:key
DELETE /api/v1/platform/tenants/:companyId/draft/shops/:shopId/modules/:key

# Preview / publish / versions
POST   /api/v1/platform/tenants/:companyId/draft/preview               # → snapshot, diff, validation errors
POST   /api/v1/platform/tenants/:companyId/publish                     # body: { expectedBaseVersion, note }
GET    /api/v1/platform/tenants/:companyId/versions
GET    /api/v1/platform/tenants/:companyId/versions/:v
GET    /api/v1/platform/tenants/:companyId/versions/:a/diff/:b
POST   /api/v1/platform/tenants/:companyId/versions/:v/rollback        # body: { expectedBaseVersion, note }
GET    /api/v1/platform/tenants/:companyId/effective?userId=&shopId=   # provenance view

# Custom fields (Phase 5) — draft, published with the rest
GET    /api/v1/platform/tenants/:companyId/draft/custom-fields?module=products
POST   /api/v1/platform/tenants/:companyId/draft/custom-fields
PATCH  /api/v1/platform/tenants/:companyId/draft/custom-fields/:id
POST   /api/v1/platform/tenants/:companyId/draft/custom-fields/:id/archive
POST   /api/v1/platform/tenants/:companyId/draft/custom-fields/:id/restore

# Templates / import / export (Phase 7)
GET    /api/v1/platform/templates
GET    /api/v1/platform/tenants/:companyId/versions/:v/export
POST   /api/v1/platform/tenants/:companyId/draft/import               # file or templateKey

# Audit
GET    /api/v1/platform/tenants/:companyId/audit?type=config
```

### 8.2 User-Facing APIs

```
GET    /api/v1/me/config                       # §5.4; ETag = version + prefs hash
PUT    /api/v1/me/preferences/:scope           # restricted schema (§4.4)
```

Custom field definitions for form rendering are part of `modules[key].config`
in `/me/config`, filtered by the user's `readRoles`.

---

## 9. Security Model

### 9.1 Request Pipeline

```
JwtAuthGuard          → authentication
PermissionsGuard      → resource:action      (config cannot override)
SubscriptionWriteGuard→ plan enforcement     (config cannot override)
ModuleEnabledGuard    → NEW: 403 MODULE_DISABLED if module not usable for this company
TenantRlsInterceptor  → tenant isolation (interceptors run after all guards)
Business logic        → reads resolved config; validates writes against it (§9.2)
```

`ModuleEnabledGuard` closes a gap: hiding a module in the sidebar is not enough;
its API must also refuse requests when the tenant has disabled it. Controllers
opt in with `@RequiresModule('<key>')`. Because guards run before interceptors,
the guard takes `companyId` from the authenticated `request.user` (the same
source `TenantRlsInterceptor` uses), not from `TenantContext`.

### 9.2 API-Level Enforcement of Business Config

Business config affects what the API accepts, not only what the UI shows:

- **Mandatory fields:** create/update DTO validation adds the company's
  `mandatoryFields` for that module at runtime. Missing → `422`.
- **Hidden fields:** values for hidden fields are ignored on write and omitted on read.
- **Locked fields:** `lockedMandatoryFields` are always required regardless of config.
- **Custom fields:** validated per §4.5, including `writeRoles`.
- **Field read permissions:** fields with `readRoles` are stripped from responses
  for other roles (lists, details, exports, PDFs).

### 9.3 Admin Security

- All admin routes behind `PlatformAdminGuard`; every mutation audited with actor, before/after and IP
- Admin dashboard on a separate subdomain (e.g. `admin.softdigit.app`)
- `isPlatformAdmin` set only via database/ops procedure, never via API
- Stricter rate limits on `/platform/*`
- Bulk operations bounded (max 50 modules per request)

### 9.4 Isolation Tests — from Phase 1, not Phase 8

Written alongside the code that could break them:
- Company A's users cannot read Company B's config, preferences or custom field values
- Publishing for Company A does not change Company B's resolved config or cache keys
- Cache keys are derived from `TenantContext`, never request input (test with spoofed IDs)
- Non-platform-admin → `403` on every `/platform/*` route (route table test, so new routes are covered automatically)
- Config never grants access: a module enabled in config but blocked by plan or permission stays blocked

---

## 10. Backward Compatibility Strategy

1. **Registry defaults equal current behaviour.** A company with no `ConfigVersion`
   gets exactly today's experience. A regression test asserts the default
   sidebar equals today's `SIDEBAR_SECTIONS` (after permission filtering).
2. **Sidebar fallback.** If `/me/config` fails, the frontend uses `SIDEBAR_SECTIONS`.
3. **Custom fields are additive.** `custom_fields` defaults to `null`; nothing
   appears without published definitions.
4. **Plan gating stays authoritative.** Config cannot enable a module the plan forbids.

**Migration path:** additive schema → services deployed but unused → frontend
with fallback → first enterprise client configured through the admin API
(Postman) while the dashboard is built.

---

## 11. Implementation Phases & GitHub Epics

Each phase ships its own tests. Phase 8 is final validation and pilot, not the
first time anything is tested.

### Phase 1 — Configuration Engine Foundation (E01 + E02) — Critical

**E01: Tenant Configuration Foundation**
- [ ] Verify existing infrastructure claims in §2.1 (behaviour + tests); record gaps as issues
- [ ] `TenantModuleConfig` (draft working set) + `NULLS NOT DISTINCT` unique index
- [ ] `ConfigVersion` (immutable published snapshots)
- [ ] `UserPreference` (restricted schema)
- [ ] `ConfigDraftService` with revision-based optimistic concurrency
- [ ] `ConfigPublishService`: validate, publish, preview, rollback, diff (no UI)
- [ ] Isolation and publish-concurrency tests

**E02: Module Registry & Resolution**
- [ ] `MODULE_REGISTRY` with all modules, `configSchema`, `defaults`, `dependsOn`, `shopOverridable`
- [ ] Registry invariant tests (defaults parse, deps exist, no cycles)
- [ ] `ConfigResolverService` with versioned snapshot cache (§5.2)
- [ ] `ModuleRegistryService.isUsable`
- [ ] `ConfigModule` wiring
- [ ] Resolver tests: defaults, shop overrides, Redis-down, stampede, provenance

### Phase 2 — Admin & User APIs (E03) — Critical
- [ ] `/platform/tenants/...` draft, preview, publish, versions, diff, rollback, effective
- [ ] `/me/config` (with ETag) and `/me/preferences`
- [ ] `ModuleEnabledGuard`
- [ ] Audit logging, DTO validation, rate limits
- [ ] Route-table test: every `/platform/*` route requires platform admin

### Phase 3 — Admin Dashboard (E04) — High
- [ ] Scaffold `apps/admin`; auth; tenant list/detail
- [ ] Schema-driven module config editor (draft)
- [ ] Preview & diff, publish with validation errors, version history, rollback
- [ ] Effective-config (provenance) view
- [ ] Build + deploy pipeline

### Phase 4 — Dynamic UI & API Enforcement (E05) — High
- [ ] Sidebar from `/me/config` with fallback
- [ ] Module gate combining plan + `usable`
- [ ] Module label renaming; table column visibility; dashboard widget visibility
- [ ] API-level enforcement of mandatory/hidden/locked fields (§9.2) in business module write paths
- [ ] Tests: default config ≡ today's behaviour; enforcement per module

### Phase 5 — Custom Fields (E06) — High
- [ ] `CustomFieldDefinition` + `custom_fields` columns + GIN indexes
- [ ] Draft/publish integration (definitions in snapshot)
- [ ] Backend value validation + field permissions on all supporting entities
- [ ] Lifecycle rules (§4.5) enforced in the API
- [ ] Frontend form renderer, table columns, filters for `searchable` fields
- [ ] Admin field builder UI

### Phase 6 — Workflow & Policy Admin (E07) — Medium
- [ ] Admin API over existing `WorkflowGraph`/`WorkflowVersion` (compile before save)
- [ ] Admin API for policy rules using the existing condition vocabulary only
- [ ] Expose `FeatureFlagsService.setEnabled()` per company
- [ ] Admin UI: approval chain editor, policy rule editor
- [ ] Integration tests: company-specific workflow runs

### Phase 7 — Templates, Import/Export & Lifecycle Tooling (E08) — Medium
- [ ] Export/import (into drafts) with `schemaVersion`
- [ ] Industry templates (Manufacturing, Retail, Wholesale) as reviewed files
- [ ] Audit diff viewer
- [ ] Snapshot schema migration framework (§4.6) + first migration test

### Phase 8 — Enterprise Validation & Pilot (E09) — Critical
- [ ] Full security review and pen test of `/platform/*` and config paths
- [ ] Load test (§12 targets)
- [ ] Full regression with empty config
- [ ] First-client pilot checklist and sign-off

---

## 12. Acceptance Criteria per Phase

### Phase 1
- Tenant requests read only published snapshots; editing a draft changes nothing a tenant sees
- Publish is atomic; concurrent publishes for one company → exactly one succeeds, the other gets `409`
- Publish rejects invalid config and broken dependencies, returning all errors
- Rollback creates a new version; history intact
- Resolver keeps serving from Postgres when Redis is down
- Isolation tests (§9.4) pass; zero existing tests broken

### Phase 2
- All admin endpoints behave per §8.1; every mutation audited
- Non-platform-admin → `403` on every `/platform/*` route (route-table test)
- Disabled module's API returns `403` with code `MODULE_DISABLED` via `ModuleEnabledGuard`
- `/me/config` returns `304` when unchanged

### Phase 3
- Admin can edit draft, preview diff, publish, view history and roll back for any tenant
- Published change visible to the tenant within 5 seconds

### Phase 4
- Sidebar renders from `/me/config`; falls back when the API is unavailable
- Default config renders exactly today's sidebar
- Mandatory fields are enforced by the API (direct API call without the field → `422`)

### Phase 5
- Custom field values validated server-side; unknown keys rejected
- Field read/write permissions enforced in API responses and writes
- Archived fields keep their data; type change blocked once values exist

### Phase 6
- Approval chains configurable per company using existing engines
- Invalid workflow graphs and out-of-vocabulary policy conditions rejected

### Phase 7
- Export from staging → import → preview → publish in production reproduces the config
- Applying a template produces a valid, publishable draft

### Phase 8
- **Server-side resolution:** p99 < 5ms with warm in-process cache
- **End-to-end `GET /me/config`:** p95 < 50ms at 50 companies × 10 concurrent users
- **Cold path (cache miss → Postgres):** p95 < 200ms
- Pen test: no critical/high findings open
- First client live with custom modules, fields and workflows

---

## 13. Team Responsibilities

| Role | Phases | Focus |
|---|---|---|
| Tech Lead | 1, 2, 8 | Data contracts, publish lifecycle, security model, reviews |
| Backend Lead | 1, 2, 4, 5, 6 | Prisma models, services, API enforcement, workflow integration |
| Frontend Lead | 3, 4 | Admin dashboard, dynamic sidebar, config-driven UI |
| Full-Stack | 5, 7 | Custom fields, templates, import/export |
| QA | Every phase | Phase tests, isolation, regression, load |

---

## 14. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Admin misconfiguration breaks a client | High | Critical | Drafts never live; schema + dependency validation at publish; preview + diff; one-click rollback (all Phase 1–3) |
| Two admins overwrite each other | Medium | High | Draft `revision` checks; `expectedBaseVersion` on publish |
| Config resolution adds latency | Medium | High | Immutable snapshots, in-process + Redis cache, single-flight |
| Redis outage | Low | Medium | Postgres fallback; never fall back to defaults when a snapshot exists |
| Config schema evolves, old snapshots invalid | Medium | High | `schemaVersion` + migration functions (§4.6) |
| Custom fields slow queries | Medium | Medium | GIN index; per-field expression indexes on measured need |
| UI-only enforcement bypassed via API | Medium | High | §9.2 enforcement + `ModuleEnabledGuard` |
| Sidebar API failure locks users out | Low | Critical | Frontend fallback to `SIDEBAR_SECTIONS` |
| Existing infrastructure weaker than assumed | Medium | High | Phase 1 verification task (§2.1) |

---

## 15. Out of Scope (Future Work)

- Multi-region deployment
- Per-tenant databases (RLS is sufficient unless a client demands it)
- Plugin/extension system — custom code goes through SoftDigit engineering
- White-label mobile app
- Unique constraints on custom field values
- AI-powered configuration suggestions

---

*This document must be approved before implementation begins. It is the
architectural source of truth for the GitHub project.*
