# Existing Infrastructure Verification (#177)

**Date:** 2026-11-04 · **Spec:** [§2.1](2026-11-03-enterprise-customization-spec.md#21-what-already-exists-reuse--dont-rebuild) · **Epic:** #147

Spec Revision 1 called these components production-ready without checking. This
records what each one actually does at `main` (after #232), what tests cover it,
and the gaps that matter for the tenant-config work. Each gap links to its
issue at the end.

Method: read the code paths listed in §2.1, counted RLS state from a freshly
migrated database (`pg_class.relrowsecurity`), walked every controller's
decorators, and checked each component for unit and e2e tests.

## Summary

| Component | Verdict | Blocking gaps |
|---|---|---|
| Tenant isolation (RLS + `TenantContext`) | Works where enabled; covers 25 of 147 tables | G1, G2, G3 |
| Feature flags | Works for 7 workflow flags | G4 |
| Role permissions + `PermissionsGuard` | Works; locked roles honoured; fresh per request | G5 |
| Plan gating (`planAllowsFeature`, limits) | Partly enforced | G6 |
| `SubscriptionWriteGuard` | Works as documented | none |
| Policy engine | Works; validated; not versioned | G7 (minor) |
| Workflow engine | Works; compiled, versioned, immutable | G7 (minor) |
| Branding | Works; ownership checked | none |
| Platform admin (`PlatformAdminGuard`, audit) | Works; audited | Reported separately |
| Approvals | Works; approver checked | none |

## Findings

### 1. Tenant isolation: `TenantRlsInterceptor`, `TenantContext`, `PrismaService`

**Verified**

- Every Prisma model operation runs in a transaction that first sets
  `app.current_company_id` and `app.allow_unscoped_access` (`prisma/prisma.service.ts`).
- Policies fail closed: migration `20261027100000_fail_closed_tenant_rls` makes
  unscoped access require `app.allow_unscoped_access = 'true'`.
- CI connects as a non-superuser and fails if RLS is bypassed (`integration-tests.yml`, #229).
- **25 tables** have RLS enabled and forced:
  - **Tenant master data:** companies, shops, users, storage_locations, suppliers, customers, customer_activities
  - **Document headers:** purchase orders, goods receipts, goods issues, sales orders, invoices
  - **Workflow engine:** workflow graphs, versions, nodes and decision logs
  - **Notification and AI:** notification_policies, notification_timeline, recipient_engagements, dispatch_batch_items, ai_memory, assistant_actions
  - **Tenant config:** tenant_module_configs, config_versions, user_preferences
- Explicit system access (`TenantContext.runWithSystemAccess`) is used in only three places, all of them platform-admin code: platform subscriptions (service and controller) and config admin.

**Tests:** `test/tenant-isolation.e2e-spec.ts` (#178) covers the config tables,
and the CI role check proves RLS is not bypassed. `phase5-security.e2e-spec.ts`
covers authentication and role checks, not cross-tenant access. There are no tests
that one tenant cannot read another's business documents through the API, and no
unit tests for the Prisma tenant extension or `TenantRlsInterceptor`.

**Gaps**

- **G1: No context means RLS is bypassed.**
  - Mechanism: `const systemAccess = ctx ? ctx.systemAccess : true;` in `PrismaService`. Any query made outside a `TenantContext` runs unscoped.
  - Who is affected: queue workers, cron jobs, guards (which run before the interceptor), module init, and every `@Public` route (the interceptor sets `systemAccess` for public handlers).
  - Most of these are intended, and they scope by `companyId` explicitly. The problem is the default: a new job or guard that forgets to scope reads every tenant's data, and nothing flags it.
  - Proposed fix: make the no-context default `false`, with explicit `runWithSystemAccess` at the known entry points, behind a log-only mode first.
- **G2: About 70 tenant tables have no RLS.** Isolation for them depends on every query filtering by shop or company.
  - Tables with `shop_id`: stock_ledger, stock_summary, cost_layers, product_plants, payment_receipts, credit_notes, supplier_bill_header, supplier_payments, rfq_header, supplier_quote_header, sales_quote_header, contract_header, customer_returns, supplier_returns, eway_bills, damaged_stock, document_sequences, alert_events, user_invitations.
  - Tables with `company_id`: about 55, including audit_logs, approval_requests, company_settings, inventory_lots, backup_jobs, backup_provider_credentials, notifications, outbox_events, subscription_invoices, email_sender_identities and media_assets.
  - Line-item tables (`*_items`) have neither column, so they would need policies through their header.
  - This is the largest gap: the config layer's isolation tests (§9.4) only hold for the 25 covered tables.
- **G3: `products` is a global table.**
  - It has no company or shop column; tenants reach products through `product_plants`.
  - `product_code` is unique across all tenants, so company B can't create `SKU-001` once company A has it, and the conflict tells B the code exists.
  - Custom fields for products (Phase 5) will need a tenant key on the product.

### 2. Per-company feature flags: `workflow-engine/ops/feature-flags.service.ts`

**Verified**

- Flags resolve in order: per-company override (a `notification_policies` row with `scope='feature-flag'`), then the env default `WORKFLOW_FLAG_<NAME>`, then a built-in default.
- Results are cached in Redis for 30 s, and the cache key is deleted on write. A Redis failure falls back to Postgres.
- There are 7 flags, all for the workflow engine.

**Tests:** none for `FeatureFlagsService`.

**Gaps (G4)**

- `POST /workflow-engine/features/:feature` is open to tenant OWNER/ADMIN. A tenant can enable dark-launched features (`ai-advisor`, `graph-execution`, `predictive-ai`) itself, which defeats "enabled tenant-by-tenant" rollout.
- `:feature` isn't checked against the known flags, so any string is stored as a flag row.
- There's no unique key on `(company_id, scope, name)`, and `setEnabled` reads then creates. Two concurrent writes can store two rows, and `findFirst` then returns either one.
- Flags shouldn't be extended to modules. Module enablement now lives in the tenant config (#156–#160); this service should stay a platform-side dark-launch switch.

### 3. Role permissions: `common/auth/role-permissions.ts` + `PermissionsGuard`

**Verified**

- **Per-company overrides:** stored in `system_settings` under `role_permissions_v1:company:<id>`, and validated by `assertValidPermissions`.
- **Locked roles:** OWNER and ADMIN can't be overridden; they always get their base permissions.
- **Fresh on every request:** permissions are resolved per request in `jwt.strategy.ts`, so an override takes effect at once. The cost is one database read per request.
- **Wildcard:** `*` is honoured.
- **Shop scope:** shop-scoped roles (SHOP_USER, WAREHOUSE_STAFF, EMPLOYEE, SALES, VIEWER, VENDOR) are refused when they pass another shop's `shopId`.
- **`@Roles`:** both controllers that use `@Roles` also apply `RolesGuard`, so those checks are real.

**Tests:** `role-permissions.spec.ts` and `roles.guard.spec.ts`. There is no spec for `PermissionsGuard`.

**Gaps (G5)**

- **Undecorated routes:** a route without `@RequirePermission` or `@RequireAnyPermission` lets any authenticated user through.
  - 42 of the 229 business routes have no declared permission. Most check the role inside the service (document-series, email-notifications, email-senders), are per-user by design (notifications), or are the assigned-approver flow (approvals).
  - That works, but it's invisible to a route-table test and easy to lose in a refactor.
- **Shop-scope check skipped:** the check runs after the early return, so it never runs on undecorated routes.
- **Public routes inside a tagged controller:** `returns.controller.ts` has two `@Public` supplier-acknowledgement routes inside a module-tagged controller. `ModuleEnabledGuard` skips them, because they have no user, the same way the portals were skipped before #232.

### 4. Plan gating: `common/plans/plan-config.ts`

**Verified**

- `planAllowsFeature` matrix: PLUS allows everything; PRO allows everything except `api`, `vendor_portal` and `audit_rbac`; TRIAL gets none of the listed features.
- `PLAN_LIMITS` are enforced on create: `assertUserLimit` (users, invites), `assertWarehouseLimit` (shops) and `assertSkuLimit` (products and bulk import).
- All 9 plan gates in the module registry are checked somewhere in their services.

**Tests:** `plan-config.spec.ts`.

**Gaps (G6)**

- **Gating is per method and uneven.** Purchase orders check only `create` and `sendToSupplier`; most other modules check `create` and `get`. Lists, updates and status changes (confirm, cancel, fulfill) are mostly not plan-checked, so a TRIAL company can still list and confirm documents.
  - Fix: a declarative `@RequiresPlanFeature` beside `@RequiresModule`, which the registry already has the data for (`planGate`).
- **Display-only features:** `api`, `vendor_portal`, `audit_rbac` and `integrations` are reported to the UI by `SubscriptionService`, but no server code checks them.
- **Limit race:** the limit checks count and then create, so concurrent creates can exceed a limit by one or two.

### 5. Subscription write guard: `billing/guards/subscription-write.guard.ts`

**Verified:**
- Reads are always allowed.
- Writes are refused with `403 SUBSCRIPTION_READ_ONLY` once the plan has expired past its grace period.
- Writes stay allowed for auth, billing, platform, notifications, devices, `/users/me`, backups, export and PDF.
- It can be turned off with `SUBSCRIPTION_READ_ONLY_ENFORCED=false`.

**Tests:** `subscription-write.guard.spec.ts` (4 cases) and `test/workflows/subscription-read-only.e2e-spec.ts`. **No gaps.**

### 6. Policy engine: `workflow-engine/policy/`

**Verified:**
- Conditions are trees of `all`/`any`/`not` over a fixed set of comparators.
- Conditions are validated on write: depth is capped at 10, comparators are checked, and `in` requires an array.
- Rules are ordered by priority, and the most specific rule wins.
- Evaluation results are cached per company and invalidated by a generation counter.

**Tests:** `policy-evaluator.spec.ts` (4 cases). No spec for `PolicyService`.

**Gaps (G7, minor):**
- Policies take effect as soon as they're written: there is no draft, versioning or rollback. Phase 6 (#170) should store them in the tenant config publish flow rather than add its own.
- `all`/`any` arrays have no size cap.

### 7. Workflow engine: `workflow-engine/graph/`

**Verified:**
- `compileWorkflow` checks:
  - exactly one ENTRY node
  - ACTION nodes have an action
  - edges point to known nodes
  - CONDITION nodes have both branches
  - no cycles (Kahn sort) and no unreachable nodes
- Publishing creates a new immutable `workflow_versions` row; `(graph_id, version)` is unique.
- Threads stay pinned to the version they started on, and a tenant's graph overrides the system default.

**Tests:**
- `workflow-compiler.spec.ts` (8 cases), `workflow-runtime.spec.ts`, `workflow-thread-runner.spec.ts` and `graph-step-payload.spec.ts`, 20 cases in total.
- No spec for `WorkflowRegistryService`.

**Gaps (G7, minor):**
- An invalid graph throws a plain `Error`, so `POST /workflow-engine/workflows/:key/publish` returns 500 instead of 400 with the compile errors.
- Two concurrent publishes collide on the unique key and the loser gets a 500.

### 8. Branding: `common/branding/`

**Verified:**
- Company and shop branding updates first load the target through `CompaniesService.get` / `ShopsService.get`, which apply the caller's ownership and RLS. Shop branding also checks `assertPlantAccess`.
- Media assets are stored per company.

**Tests:** `update-branding-profile.dto.spec.ts` and `test/branding/historical-pdf-regeneration.spec.ts`. No service tests. **No blocking gaps.**

### 9. Platform admin: `modules/platform/`

**Verified:**
- `PlatformAdminGuard` allows a request only when the signed-in user's email is in `PLATFORM_ADMIN_EMAILS`. If the allowlist is empty, every request is refused.
- Platform mutations are audited with `PlatformAuditService.logPlatformAction`. This covers subscriptions, platform notifications and config admin.

**Tests:** `platform-admin.util.spec.ts`, plus the e2e suites `platform-subscriptions.e2e-spec.ts` and `config-admin.e2e-spec.ts`.

**Gaps:** one finding was reported to the maintainers directly rather than in this document.

### 10. Approvals: `modules/approvals/`

**Verified:**
- `approve` and `reject` check `approval.assignedTo === approverId`, and are scoped by company through `requireCompanyId`.
- Comments and escalation are scoped by company.

**Tests:** `approval.audit.spec.ts`. **No blocking gaps.** Any authenticated user can create an approval request, which seems intended.

## Gap issues

| ID | Issue | Title | Priority | Blocks |
|---|---|---|---|---|
| G2 | #238 | RLS on remaining tenant tables (shop_id, company_id and line-item tables) | critical | #178, #172 |
| G1 | #239 | Make missing `TenantContext` fail closed (explicit system access for jobs and guards) | high | #172 |
| G6 | #240 | Declarative plan gating (`@RequiresPlanFeature`) and server enforcement of api/vendor_portal/audit_rbac | high | #166 |
| G3 | #241 | Tenant key on products; product code unique per company | high | #167 |
| G5 | #242 | `@RequirePermission` on every business route (route-table test); shop-scope check on all routes; module check for public return acknowledgements | medium | #172 |
| G4 | #243 | Feature flags: platform-only writes, validate flag names, unique key | medium | — |
| G7 | #244 | Workflow publish returns 400 with compile errors; policy array size cap | low | #169, #170 |
