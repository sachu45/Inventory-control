# SoftDigit IMS — Enterprise Customization Technical Architecture Specification

**Date:** 2026-11-03
**Author:** Architecture Team
**Status:** Draft — Pending Review

---

## 1. Executive Summary

Scale the existing SoftDigit IMS from a subscription-tiered SaaS into a fully
customizable enterprise IMS platform where **every module's behaviour, visibility,
fields, workflows and branding are configurable per-tenant** from an internal
SoftDigit admin dashboard — without forking the codebase.

**Core principle:** One codebase, one deployment. Every ₹10L client gets a
tailored experience through configuration, not code branches.

---

## 2. Current Architecture Assessment

### 2.1 What Already Exists (Reuse — Don't Rebuild)

| Capability | Location | Status |
|---|---|---|
| Multi-tenant isolation | `apps/api/src/common/tenant/tenant-rls.interceptor.ts` + `tenant-context.ts` — AsyncLocalStorage with `companyId` scoping | Production-ready |
| Per-company feature flags | `apps/api/src/common/workflow-engine/ops/feature-flags.service.ts` — Redis-cached, env fallback, per-company overrides via `NotificationPolicy` | Production-ready |
| Role-based permissions | `apps/api/src/common/auth/role-permissions.ts` — per-company overrides stored in `system_settings`, `resource:action` format | Production-ready |
| Subscription plan gating | `apps/api/src/common/plans/plan-config.ts` — TRIAL/PRO/PLUS with `planAllowsFeature()` and `PLAN_LIMITS` | Production-ready |
| Subscription write guard | `apps/api/src/modules/billing/guards/subscription-write.guard.ts` — expired plans become read-only | Production-ready |
| Frontend feature gate | `apps/web/src/components/TrialFeatureGate.tsx` — plan-based feature locking with upgrade CTA | Production-ready |
| Policy engine | `apps/api/src/common/workflow-engine/policy/` — condition trees, fact evaluation, priority-ordered rules | Production-ready |
| Workflow engine | `apps/api/src/common/workflow-engine/graph/` — versioned DAG compiler, runtime, thread runner | Production-ready |
| Branding system | `apps/api/src/common/branding/` — profiles, document branding, media assets per company | Production-ready |
| Platform admin | `apps/api/src/modules/platform/` — `PlatformAdminGuard`, audit service, subscription dashboard | Basic — needs expansion |
| Approval workflows | `apps/api/src/modules/approvals/` — configurable approval chains | Production-ready |
| Company settings store | Prisma model `CompanySetting` — key/value per company | Production-ready |
| System settings store | Prisma model `SystemSetting` — global key/value with JSON | Production-ready |
| Sidebar navigation | `apps/web/src/lib/sidebar-navigation.ts` — hierarchical sections with permission gates | Hardcoded — needs to become config-driven |

### 2.2 What's Missing (Must Build)

| Capability | Current State |
|---|---|
| Module registry | No concept of "module" as a configurable unit — modules are NestJS classes imported in `app.module.ts` |
| Tenant module configuration | `FeatureFlagsService` covers workflow features only (7 flags), not all 30+ modules |
| Per-user module overrides | No user-level config beyond role permissions |
| Custom field definitions | No dynamic field system — all fields are Prisma schema columns |
| Config versioning / publishing | Feature flags are live-on-write, no draft/publish/rollback |
| Admin dashboard app | No `apps/admin` exists |
| Config-driven sidebar | `SIDEBAR_SECTIONS` is a hardcoded array, not fetched from API |
| Per-tenant UI layout config | No mechanism to customize forms, tables, dashboard widgets per company |

### 2.3 Existing Data Model (Key Tables)

**150+ Prisma models** in a 4333-line schema. Key structural ones for this work:

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

### 3.1 Configuration Resolution Hierarchy

```
Platform Defaults (code + env)
  └─► Company Config (tenant_module_configs table)
        └─► Shop/Plant Config (tenant_module_configs with shopId)
              └─► Role Config (role permissions + role_ui_overrides)
                    └─► User Override (user_config_overrides table)
```

**Resolution algorithm** (implemented as `ConfigResolverService`):

```typescript
// Pseudocode — each level merges into the previous
async resolveModuleConfig(
  companyId: string,
  shopId: string | null,
  roleId: string,
  userId: string,
  moduleKey: string,
): Promise<ResolvedModuleConfig> {
  const platform  = MODULE_REGISTRY[moduleKey].defaults;
  const company   = await this.getCompanyConfig(companyId, moduleKey);
  const shop      = shopId ? await this.getShopConfig(companyId, shopId, moduleKey) : {};
  const role      = await this.getRoleUiOverride(companyId, roleId, moduleKey);
  const user      = await this.getUserOverride(companyId, userId, moduleKey);

  return deepMerge(platform, company, shop, role, user);
}
```

**Critical rule:** UI visibility config NEVER grants permissions. The `PermissionsGuard`
(already a global APP_GUARD) independently checks `resource:action` permissions on
every request. A sidebar item visible in config but missing the permission is still
blocked at the API.

### 3.2 System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                     SOFTDIGIT ADMIN (apps/admin)                    │
│  React + Mantine │ PlatformAdminGuard │ Internal SoftDigit team     │
│                                                                     │
│  Tenant Mgmt │ Module Config │ UI Builder │ Workflow Config         │
│  Custom Fields │ Branding │ Roles │ Limits │ Audit │ Versioning    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ REST API (same apps/api)
┌──────────────────────────────▼──────────────────────────────────────┐
│                    CONFIGURATION LAYER (new)                        │
│                                                                     │
│  ModuleRegistryService     │ Defines available modules & defaults   │
│  ConfigResolverService     │ Hierarchical config resolution         │
│  ConfigVersioningService   │ Draft → Preview → Publish → Rollback  │
│  CustomFieldService        │ JSON Schema field definitions          │
│                                                                     │
│  ── Adapts into existing ──                                         │
│  FeatureFlagsService       │ Workflow feature toggles (kept as-is)  │
│  PolicyEngine              │ Business rules per tenant              │
│  WorkflowEngine            │ Configurable approval/dunning/routing  │
│  BrandingService           │ Per-tenant branding                    │
│  SubscriptionService       │ Plan limits & feature gating           │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                    EXISTING BUSINESS MODULES                        │
│                                                                     │
│  Products │ PurchaseOrders │ Sales │ Invoices │ Warehouse │ Stock   │
│  Suppliers │ Customers │ RFQs │ Contracts │ Returns │ Payments     │
│  GoodsReceipts │ GoodsIssues │ StockTransfers │ Reports │ ...      │
│                                                                     │
│  Each module reads its config via ConfigResolverService              │
│  Each module checks permissions via existing PermissionsGuard       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                    DATA & INFRASTRUCTURE                             │
│                                                                     │
│  PostgreSQL (RLS) │ Redis (config cache) │ BullMQ │ S3 │ Sentry   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Database Schema — New Models

### 4.1 Module Registry (code-defined, not DB)

The module registry lives in code as a TypeScript constant — not in the database.
This prevents config corruption from creating phantom modules.

**New file:** `apps/api/src/common/config/module-registry.ts`

```typescript
export interface ModuleDefinition {
  key: string;                    // e.g. 'products', 'purchase-orders'
  label: string;                  // Human-readable name
  description: string;
  sidebarSection: string;         // Maps to SidebarSectionId
  sidebarPath: string;            // e.g. '/products'
  sidebarIcon: string;            // Icon key from iconMap
  defaultEnabled: boolean;        // Platform default
  planGate: PlanFeature | null;   // Existing plan feature gate, or null if always available
  requiredPermission: string | null; // e.g. 'product:read'
  customizableFields: string[];   // Field keys that can be shown/hidden/required
  supportsCustomFields: boolean;  // Whether JSON custom fields are allowed
  supportsWorkflows: boolean;     // Whether workflow rules apply
}

export const MODULE_REGISTRY: Record<string, ModuleDefinition> = {
  'dashboard': {
    key: 'dashboard',
    label: 'Dashboard',
    description: 'Overview KPIs and insights',
    sidebarSection: 'overview',
    sidebarPath: '/dashboard',
    sidebarIcon: 'dashboard',
    defaultEnabled: true,
    planGate: null,
    requiredPermission: null,
    customizableFields: [],
    supportsCustomFields: false,
    supportsWorkflows: false,
  },
  'products': {
    key: 'products',
    label: 'Products',
    description: 'Product catalog and master data',
    sidebarSection: 'master-data',
    sidebarPath: '/products',
    sidebarIcon: 'products',
    defaultEnabled: true,
    planGate: null,
    requiredPermission: 'product:read',
    customizableFields: [
      'hsnCode', 'brand', 'taxPreference', 'minStock',
      'maxStock', 'reorderPoint', 'batchTracking', 'expiryTracking',
    ],
    supportsCustomFields: true,
    supportsWorkflows: false,
  },
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
    customizableFields: [
      'expectedDeliveryDate', 'logistics', 'taxFields',
      'lineDescription', 'supplierRef',
    ],
    supportsCustomFields: true,
    supportsWorkflows: true,
  },
  // ... one entry per module (all 30+)
};
```

### 4.2 New Prisma Models

**Three new tables for Phase 1-2. Not more.**

```prisma
// ─── Tenant Module Configuration ──────────────────────────────────
// Per-company (and optionally per-shop) module settings.
// This replaces the need to overload FeatureFlagsService or NotificationPolicy.

model TenantModuleConfig {
  id         String   @id @default(uuid()) @db.Uuid
  companyId  String   @map("company_id") @db.Uuid
  shopId     String?  @map("shop_id") @db.Uuid        // null = company-wide
  moduleKey  String   @map("module_key")               // e.g. 'products', 'purchase-orders'
  enabled    Boolean  @default(true)
  config     Json     @default("{}")                    // Module-specific settings
  //   config example for purchase-orders:
  //   {
  //     "approvalLevels": 4,
  //     "mandatoryFields": ["expectedDeliveryDate", "logistics"],
  //     "hiddenFields": ["lineDescription"],
  //     "poNumberFormat": "PO-{YYYY}-{SEQ:5}",
  //     "maxPoValueWithoutApproval": 100000
  //   }
  version    Int      @default(1)                       // Optimistic concurrency
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt  DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)
  createdBy  String?  @map("created_by") @db.Uuid
  updatedBy  String?  @map("updated_by") @db.Uuid

  company Company @relation(fields: [companyId], references: [id], onDelete: Cascade)
  shop    Shop?   @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@unique([companyId, shopId, moduleKey])
  @@index([companyId])
  @@map("tenant_module_configs")
}


// ─── User Config Override ─────────────────────────────────────────
// Per-user overrides (sidebar order, hidden columns, personal preferences).
// NEVER contains permission grants — only UI preferences.

model UserConfigOverride {
  id         String   @id @default(uuid()) @db.Uuid
  companyId  String   @map("company_id") @db.Uuid
  userId     String   @map("user_id") @db.Uuid
  moduleKey  String   @map("module_key")
  config     Json     @default("{}")
  //   config example:
  //   {
  //     "hiddenColumns": ["hsnCode", "brand"],
  //     "defaultSort": "name:asc",
  //     "sidebarPinned": true
  //   }
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt  DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  company Company @relation(fields: [companyId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([companyId, userId, moduleKey])
  @@index([companyId, userId])
  @@map("user_config_overrides")
}


// ─── Custom Field Definition ──────────────────────────────────────
// Dynamic fields added to modules per tenant.

model CustomFieldDefinition {
  id            String   @id @default(uuid()) @db.Uuid
  companyId     String   @map("company_id") @db.Uuid
  moduleKey     String   @map("module_key")            // e.g. 'products'
  fieldKey      String   @map("field_key")             // e.g. 'warehouse_zone'
  label         String                                  // Display name
  fieldType     String   @map("field_type")            // text | number | date | select | boolean
  options       Json?                                   // For select: ["Zone A", "Zone B"]
  required      Boolean  @default(false)
  defaultValue  Json?    @map("default_value")
  sortOrder     Int      @default(0) @map("sort_order")
  isActive      Boolean  @default(true) @map("is_active")
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  company Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  @@unique([companyId, moduleKey, fieldKey])
  @@index([companyId, moduleKey])
  @@map("custom_field_definitions")
}
```

### 4.3 Custom Field Values Storage

Custom field values are stored as a `Json` column on existing entity tables
(`customFields Json? @map("custom_fields")`). This avoids an EAV anti-pattern
while keeping queries simple.

**Tables that get a `custom_fields` column** (Phase 5):
- `products`
- `purchase_order_headers`
- `sales_order_headers`
- `invoice_headers`
- `suppliers`
- `customers`
- `goods_receipt_headers`
- `goods_issue_headers`

### 4.4 Config Versioning (Phase 7)

Added later to avoid over-engineering Phase 1:

```prisma
model ConfigVersion {
  id          String   @id @default(uuid()) @db.Uuid
  companyId   String   @map("company_id") @db.Uuid
  status      String   @default("draft")              // draft | preview | published | rolled_back
  snapshot    Json                                     // Full config snapshot at publish time
  publishedAt DateTime? @map("published_at") @db.Timestamptz(6)
  publishedBy String?  @map("published_by") @db.Uuid
  rollbackOf  String?  @map("rollback_of") @db.Uuid   // Points to the version this rolled back
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  company Company @relation(fields: [companyId], references: [id], onDelete: Cascade)

  @@index([companyId, status])
  @@map("config_versions")
}
```

---

## 5. New Backend Services

### 5.1 Module Registry Service

**File:** `apps/api/src/common/config/module-registry.service.ts`

Wraps the code-defined `MODULE_REGISTRY` and enriches it with the company's
subscription plan to determine which modules are available.

```typescript
@Injectable()
export class ModuleRegistryService {
  constructor(private readonly subscriptions: SubscriptionService) {}

  async getAvailableModules(companyId: string): Promise<ModuleDefinition[]> {
    const snapshot = await this.subscriptions.getSnapshot(companyId);
    return Object.values(MODULE_REGISTRY).filter((mod) => {
      if (!mod.planGate) return true;
      return planAllowsFeature(snapshot.plan as SubscriptionPlan, mod.planGate);
    });
  }
}
```

### 5.2 Config Resolver Service

**File:** `apps/api/src/common/config/config-resolver.service.ts`

The core resolution engine. Redis-cached with 30s TTL (same pattern as
`FeatureFlagsService`).

**Cache key pattern:** `cfg:{companyId}:{shopId|_}:{moduleKey}` for company/shop
configs, `cfg:user:{companyId}:{userId}:{moduleKey}` for user overrides.

**Cache invalidation:** On any write to `tenant_module_configs` or
`user_config_overrides`, delete the relevant cache keys. The service exposes
an `invalidate(companyId, moduleKey?)` method.

### 5.3 Config Admin Service

**File:** `apps/api/src/modules/config-admin/config-admin.service.ts`

CRUD operations for tenant module configs, user overrides and custom fields.
Protected by `PlatformAdminGuard`. Every write produces an audit log entry.

### 5.4 Sidebar Config Endpoint

**File:** `apps/api/src/modules/config-admin/sidebar-config.controller.ts`

New endpoint: `GET /api/v1/me/sidebar`

Returns the resolved sidebar for the authenticated user, replacing the hardcoded
`SIDEBAR_SECTIONS`. The frontend fetches this once on login and caches it in
the auth store.

```typescript
// Response shape
type SidebarConfigResponse = {
  sections: Array<{
    id: string;
    title: string;
    children: Array<{
      kind: 'link';
      label: string;   // May be renamed per-tenant (e.g. "Plants" → "Branches")
      path: string;
      icon: string;
      badge?: { type: string };
    }>;
  }>;
};
```

---

## 6. Files to Modify (Existing Codebase)

### 6.1 Backend Changes

| File | Change |
|---|---|
| `apps/api/src/app.module.ts` | Import new `ConfigModule` |
| `apps/api/prisma/schema.prisma` | Add 3 new models (§4.2), add `custom_fields` column to 8 entity tables (Phase 5), add relations to `Company`, `Shop`, `User` |
| `apps/api/src/common/plans/plan-config.ts` | No change — reuse `planAllowsFeature()` as-is |
| `apps/api/src/common/workflow-engine/ops/feature-flags.service.ts` | No change — keep for workflow-specific flags |
| `apps/api/src/common/auth/role-permissions.ts` | No change — keep for permission resolution |
| `apps/api/src/modules/platform/platform-subscriptions.controller.ts` | Expand with config admin endpoints (or new controller) |
| `apps/api/src/modules/platform/platform.module.ts` | Import ConfigAdminModule |

### 6.2 Frontend Changes

| File | Change |
|---|---|
| `apps/web/src/lib/sidebar-navigation.ts` | Replace hardcoded `SIDEBAR_SECTIONS` with a function that reads from API response; keep as fallback |
| `apps/web/src/components/Sidebar.tsx` | Fetch sidebar config from `/api/v1/me/sidebar` instead of importing `SIDEBAR_SECTIONS` directly |
| `apps/web/src/store/authStore.ts` | Add `sidebarConfig` and `moduleConfig` to the auth store, fetched on login |
| `apps/web/src/components/TrialFeatureGate.tsx` | Extend to also check module-enabled status from config, not just plan features |

### 6.3 New Files

| File | Purpose |
|---|---|
| `apps/api/src/common/config/module-registry.ts` | Module definitions constant |
| `apps/api/src/common/config/module-registry.service.ts` | Plan-aware module availability |
| `apps/api/src/common/config/config-resolver.service.ts` | Hierarchical config resolution with Redis cache |
| `apps/api/src/common/config/config.module.ts` | NestJS module wiring |
| `apps/api/src/modules/config-admin/config-admin.module.ts` | Admin config management module |
| `apps/api/src/modules/config-admin/config-admin.controller.ts` | CRUD API for tenant configs |
| `apps/api/src/modules/config-admin/config-admin.service.ts` | Business logic for config CRUD |
| `apps/api/src/modules/config-admin/sidebar-config.controller.ts` | `/me/sidebar` endpoint |
| `apps/api/src/modules/config-admin/custom-fields.controller.ts` | Custom field definition CRUD |
| `apps/api/src/modules/config-admin/custom-fields.service.ts` | Custom field logic + validation |
| `apps/api/src/modules/config-admin/dto/*.dto.ts` | Validation DTOs |
| `apps/admin/` | Entire new admin dashboard app (see §7) |

---

## 7. Admin Dashboard Architecture (`apps/admin`)

### 7.1 Tech Stack

Same as `apps/web` for consistency:
- React 18 + TypeScript
- Mantine UI (already used in `apps/web`)
- TanStack Query + React Router
- Vite build

### 7.2 Auth

Reuses the same JWT auth from `apps/api`. The `PlatformAdminGuard` already
checks `user.isPlatformAdmin` — admin dashboard API calls are gated by this.

### 7.3 Page Structure

```
apps/admin/src/pages/
  DashboardPage.tsx          — Overview: tenant count, health, activity
  TenantsPage.tsx             — List all companies, subscription status, quick actions
  TenantDetailPage.tsx        — Single company: config, users, billing, audit
  ModuleConfigPage.tsx        — Configure modules for a selected company
  CustomFieldsPage.tsx        — Manage custom field definitions per company/module
  UserOverridesPage.tsx       — Per-user config within a company
  WorkflowConfigPage.tsx      — Expose workflow graph editor for company workflows
  BrandingPage.tsx            — Company branding (extends existing branding system)
  RolesPermissionsPage.tsx    — Configure role permission overrides per company
  AuditLogPage.tsx            — View all config changes with rollback
  ConfigVersionsPage.tsx      — Draft/publish/rollback management (Phase 7)
```

### 7.4 Module Config Editor (Key Screen)

For each company, the admin sees a table of all modules with toggles and a config
editor. Example for "Purchase Orders" for Company X:

```
┌──────────────────────────────────────────────────────────────────┐
│  Purchase Orders — Acme Manufacturing Ltd                        │
├──────────────────────────────────────────────────────────────────┤
│  Enabled: [✓]                                                    │
│                                                                  │
│  Approval Levels:        [4]                                     │
│  PO Number Format:       [PO-{YYYY}-{SEQ:5}]                   │
│  Max PO without approval: [₹1,00,000]                           │
│                                                                  │
│  Mandatory Fields:                                               │
│    [✓] Expected Delivery Date                                    │
│    [✓] Logistics / Transport                                     │
│    [ ] Tax Fields                                                │
│    [ ] Line Description                                          │
│                                                                  │
│  Hidden Fields:                                                  │
│    [ ] Supplier Reference                                        │
│                                                                  │
│  Custom Fields: (2 defined)                                      │
│    [Internal Project Code]  text, required                       │
│    [Budget Center]          select: [Ops, R&D, Sales]           │
│                                                                  │
│  [Save Draft]  [Preview as Company]  [Publish]                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 8. API Contracts

### 8.1 Admin Config APIs (PlatformAdmin-only)

```
# Tenant module configs
GET    /api/v1/admin/tenants                           # List all companies
GET    /api/v1/admin/tenants/:companyId                # Company detail + current configs
GET    /api/v1/admin/tenants/:companyId/modules        # All module configs for company
PUT    /api/v1/admin/tenants/:companyId/modules/:key   # Upsert module config
DELETE /api/v1/admin/tenants/:companyId/modules/:key   # Reset to platform defaults

# Per-shop overrides
PUT    /api/v1/admin/tenants/:companyId/shops/:shopId/modules/:key
DELETE /api/v1/admin/tenants/:companyId/shops/:shopId/modules/:key

# User overrides
GET    /api/v1/admin/tenants/:companyId/users/:userId/overrides
PUT    /api/v1/admin/tenants/:companyId/users/:userId/overrides/:key
DELETE /api/v1/admin/tenants/:companyId/users/:userId/overrides/:key

# Custom fields
GET    /api/v1/admin/tenants/:companyId/custom-fields?module=products
POST   /api/v1/admin/tenants/:companyId/custom-fields
PUT    /api/v1/admin/tenants/:companyId/custom-fields/:id
DELETE /api/v1/admin/tenants/:companyId/custom-fields/:id

# Config versioning (Phase 7)
GET    /api/v1/admin/tenants/:companyId/config-versions
POST   /api/v1/admin/tenants/:companyId/config-versions/publish
POST   /api/v1/admin/tenants/:companyId/config-versions/:id/rollback

# Audit
GET    /api/v1/admin/tenants/:companyId/audit?type=config
```

### 8.2 User-Facing Config APIs

```
# Resolved sidebar for current user
GET    /api/v1/me/sidebar

# Resolved module config for current user + current company
GET    /api/v1/me/modules/:key/config

# Custom fields for a module (for form rendering)
GET    /api/v1/modules/:key/custom-fields

# User's own preferences (self-service, not admin)
PUT    /api/v1/me/modules/:key/preferences
```

---

## 9. Security Model

### 9.1 Permission vs. Configuration Separation

```
                  ┌─────────────────┐
                  │   API Request    │
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │  JwtAuthGuard   │  ← Authentication
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │PermissionsGuard │  ← Authorization (resource:action)
                  └────────┬────────┘        BLOCKS if permission missing
                           │                 Config CANNOT override this
                  ┌────────▼────────┐
                  │SubscriptionWrite│  ← Plan enforcement
                  │     Guard       │        BLOCKS writes on expired plans
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │ TenantRlsInterc │  ← Tenant isolation
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │  Module Config   │  ← Customization (fields, workflows, UI)
                  │  Resolution      │        Only SHAPES the response, never
                  └────────┬────────┘        grants access
                           │
                  ┌────────▼────────┐
                  │ Business Logic   │
                  └─────────────────┘
```

### 9.2 Admin Dashboard Security

- All admin API routes behind `PlatformAdminGuard` (already exists)
- Every config write logged to `PlatformAuditLog` (already exists)
- Admin dashboard deployed on a separate subdomain (e.g. `admin.softdigit.app`)
- Admin users are flagged `isPlatformAdmin: true` in the `User` table

### 9.3 Cross-Tenant Isolation Tests (Phase 8)

Automated tests that must pass before each release:
- User from Company A cannot read Company B's module configs
- User from Company A cannot read Company B's custom field values
- Config change for Company A does not affect Company B's resolved config
- Cache invalidation for Company A does not clear Company B's cache
- Admin API rejects non-platform-admin users with 403

---

## 10. Backward Compatibility Strategy

### 10.1 Zero Breaking Changes for Existing Customers

1. **Module registry defaults match current behavior.** Every module currently
   active is `defaultEnabled: true`. Existing companies with no `TenantModuleConfig`
   rows get exactly the same experience they have today.

2. **Sidebar fallback.** If `/api/v1/me/sidebar` fails or returns empty, the
   frontend falls back to the hardcoded `SIDEBAR_SECTIONS`. This ensures the
   app works during migration.

3. **Custom fields are additive.** The `custom_fields` JSON column defaults to
   `null`. Existing records are unaffected. Custom fields only appear when
   `CustomFieldDefinition` rows exist for that company/module.

4. **Plan gating still works.** `planAllowsFeature()` runs before module config.
   A TRIAL company cannot enable a PRO-only module through config — the plan
   gate takes precedence.

### 10.2 Migration Path

1. Deploy new schema (additive — no existing columns change)
2. Deploy new services (ConfigResolver, ModuleRegistry) — inactive until frontend calls them
3. Deploy updated frontend with config-driven sidebar (with fallback)
4. Onboard first enterprise client: create their `TenantModuleConfig` rows via admin API
5. Gradually build admin dashboard UI while API is usable via curl/Postman

---

## 11. Implementation Phases & GitHub Epics

### Phase 1 — Configuration Foundation (E01 + E02)

**Epic E01: Tenant Configuration Foundation**
- [ ] Create `TenantModuleConfig` Prisma model + migration
- [ ] Create `UserConfigOverride` Prisma model + migration
- [ ] Add Company/Shop/User relations in schema
- [ ] Implement `ConfigResolverService` with Redis caching
- [ ] Write config resolution unit tests (hierarchy merge, cache invalidation)
- [ ] Write cross-tenant isolation tests

**Epic E02: Module Registry & Resolution**
- [ ] Define `MODULE_REGISTRY` constant with all 30+ modules
- [ ] Implement `ModuleRegistryService` (plan-aware filtering)
- [ ] Create `/api/v1/me/sidebar` endpoint
- [ ] Create `/api/v1/me/modules/:key/config` endpoint
- [ ] Wire sidebar endpoint into existing `PermissionsGuard` checks
- [ ] Integration tests: sidebar resolves correctly per role + company config

### Phase 2 — Platform Admin APIs (E03)

**Epic E03: Platform Admin APIs**
- [ ] Create `ConfigAdminModule` with `PlatformAdminGuard`
- [ ] `GET/PUT/DELETE /admin/tenants/:id/modules/:key` — module config CRUD
- [ ] `GET/PUT/DELETE /admin/tenants/:id/shops/:shopId/modules/:key` — shop overrides
- [ ] `GET/PUT/DELETE /admin/tenants/:id/users/:userId/overrides/:key` — user overrides
- [ ] Config change audit logging via existing `PlatformAuditLog`
- [ ] Input validation DTOs with class-validator
- [ ] API integration tests

### Phase 3 — Admin Dashboard (E04)

**Epic E04: Admin Dashboard App**
- [ ] Scaffold `apps/admin` (Vite + React + Mantine + React Router)
- [ ] Implement auth flow (reuse JWT from `apps/api`)
- [ ] Dashboard overview page (tenant list, health, subscription stats)
- [ ] Tenant detail page with module config editor
- [ ] Module toggle + config JSON editor per company
- [ ] Shop-level override editor
- [ ] User override editor
- [ ] Wire to Turborepo build pipeline
- [ ] Add to `.github/workflows/deploy.yml`

### Phase 4 — Dynamic UI (E05)

**Epic E05: Dynamic UI Configuration**
- [ ] Refactor `sidebar-navigation.ts` to consume `/me/sidebar` response
- [ ] Update `Sidebar.tsx` to fetch config on mount (with hardcoded fallback)
- [ ] Add module label renaming support (e.g. "Plants" → "Branches")
- [ ] Config-driven table column visibility per module
- [ ] Config-driven mandatory/optional fields per module
- [ ] Dashboard widget visibility per company
- [ ] Update `TrialFeatureGate.tsx` to check module config + plan together

### Phase 5 — Custom Fields (E06)

**Epic E06: Custom Field Engine**
- [ ] Create `CustomFieldDefinition` Prisma model + migration
- [ ] Add `custom_fields Json?` column to 8 entity tables (migration)
- [ ] Implement `CustomFieldService` (CRUD, validation, rendering metadata)
- [ ] Admin API endpoints for custom field management
- [ ] Frontend: dynamic form renderer that reads field definitions
- [ ] Frontend: custom field columns in data tables
- [ ] Admin dashboard: custom field builder UI
- [ ] Validation: JSON Schema-based field validation on API writes

### Phase 6 — Workflow & Policy Admin (E07)

**Epic E07: Workflow & Policy Administration**
- [ ] Admin endpoints to list/create/update `WorkflowGraph` per company
- [ ] Admin endpoints to manage `NotificationPolicy` rules per company
- [ ] Expose existing `FeatureFlagsService.setEnabled()` in admin API
- [ ] Admin dashboard: visual workflow editor (graph nodes + edges)
- [ ] Admin dashboard: policy rule editor
- [ ] Admin dashboard: approval chain configuration per module
- [ ] Integration test: workflow runs with company-specific config

### Phase 7 — Config Versioning (E08)

**Epic E08: Configuration Versioning**
- [ ] Create `ConfigVersion` Prisma model + migration
- [ ] Implement draft/preview/publish lifecycle in `ConfigVersioningService`
- [ ] Publish = snapshot all `TenantModuleConfig` + `CustomFieldDefinition` rows
- [ ] Rollback = restore from a previous snapshot
- [ ] Admin dashboard: version history timeline
- [ ] Admin dashboard: preview mode ("view as Company X, User Y")
- [ ] Admin dashboard: publish confirmation + rollback button

### Phase 8 — Enterprise Validation (E09)

**Epic E09: Enterprise Security & Testing**
- [ ] Cross-tenant config isolation test suite (automated)
- [ ] Permission-vs-config separation test suite
- [ ] Performance test: config resolution under load (target <5ms p99 with cache)
- [ ] Cache stampede test: cold-start behavior under concurrent requests
- [ ] Security audit: admin API access controls
- [ ] Regression suite: existing features unchanged with empty config
- [ ] First-client pilot checklist and acceptance criteria

---

## 12. Acceptance Criteria per Phase

### Phase 1
- Config resolution returns correct merged result for Platform→Company→Shop→Role→User
- Redis cache hit rate >95% for repeated config reads
- Zero existing tests broken
- Cross-tenant isolation: Company A's config invisible to Company B

### Phase 2
- All admin CRUD endpoints return correct responses
- Every config write produces an audit log entry
- Non-platform-admin users get 403 on all admin endpoints

### Phase 3
- Admin can log in, see all tenants, toggle modules, save config
- Config changes reflect in tenant's sidebar within 30 seconds

### Phase 4
- Sidebar renders from API config, not hardcoded array
- Fallback to hardcoded sidebar works when API is unavailable
- Module labels customizable (e.g. "Plants" → "Branches")

### Phase 5
- Admin can define custom fields per module per company
- Custom fields appear in tenant's forms and tables
- Custom field values persist and display correctly
- Validation rules enforced on API writes

### Phase 6
- Admin can configure approval chains per company
- Admin can toggle workflow features per company
- Workflow engine respects company-specific config

### Phase 7
- Admin can draft, preview, publish and rollback config
- Published config is the only one tenants see
- Rollback restores the previous published version

### Phase 8
- All isolation tests pass
- p99 config resolution <5ms (cached)
- First client onboarded with custom modules, fields and workflows

---

## 13. Team Responsibilities

| Role | Phases | Focus |
|---|---|---|
| Tech Lead | 1, 2, 9 | Architecture, security model, config resolution algorithm, code review |
| Backend Lead | 1, 2, 5, 6 | Prisma models, NestJS services, API endpoints, workflow integration |
| Frontend Lead | 3, 4 | Admin dashboard, dynamic sidebar, config-driven UI |
| Full-Stack | 5, 7 | Custom fields (backend + frontend), versioning |
| QA | 8 (ongoing) | Isolation tests, regression, performance |

---

## 14. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Config resolution adds latency to every request | Medium | High | Redis cache with 30s TTL; cache warm on publish |
| Custom fields create query performance issues | Medium | Medium | JSON column with GIN index; no EAV pattern |
| Admin misconfiguration breaks a client's system | High | Critical | Draft/publish lifecycle (Phase 7); rollback capability |
| Config schema evolves, old configs become invalid | Medium | High | Version field on configs; migration scripts per schema change |
| Sidebar config API failure locks users out | Low | Critical | Frontend fallback to hardcoded `SIDEBAR_SECTIONS` |

---

## 15. What This Spec Does NOT Cover (Future Work)

- **Multi-region deployment** — Single deployment for now
- **Per-tenant database isolation** — RLS is sufficient; separate databases only if a client demands it
- **Plugin/extension system** — Custom code beyond configuration goes through SoftDigit engineering
- **White-label mobile app** — Out of scope; existing React web is the primary interface
- **AI-powered configuration suggestions** — Future optimization using the existing agent platform

---

*This document should be reviewed and approved before implementation begins.
It becomes the architectural source of truth for the GitHub project.*
