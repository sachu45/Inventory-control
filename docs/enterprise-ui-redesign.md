# Enterprise workspace and authentication redesign

## Existing application mapped to the requested ERP patterns

The repository contains a React/Vite frontend, NestJS API, PostgreSQL/Prisma data layer, React Query, Zustand session state and existing JWT/rotating refresh-cookie authentication. Existing forms, API contracts, record permissions and database records are retained. No project/task modules or analytics have been fabricated.

| Workspace | Existing routes and workflow |
| --- | --- |
| Overview | Dashboard backed by inventory, stock movement, purchase and sales data |
| Inventory | Products, warehouse stock, receipts, issues, transfers, storage locations, barcode labels |
| Purchasing | RFQs, quotations, contracts, purchase orders, returns, supplier bills/payments and portal |
| Sales | Sales quotations/orders, goods issues, invoices, payments and e-way bills |
| Contacts | Customers and suppliers with existing record forms |
| Reports | Existing report APIs, date ranges, filters and supported exports |
| Approvals | Existing request statuses, due dates, document links, decisions and comments |
| Administration | Existing workflow automation, organisation, plants/locations, users, roles and account settings |

## Implemented experience

- Manrope served from local font files; restrained enterprise tokens, compact tables, shared summary metrics, consistent controls and custom SVG icons.
- Eight short sidebar entries with no explanatory subtitles. Organisation and locations live in Settings. Theme and upgrade actions live in the account menu.
- Permission-aware application launcher, breadcrumbs and contextual links for stock, purchasing, sales and contacts.
- Keyboard-accessible global search queries the actual products, customers and suppliers APIs and opens existing record panels. Partial search failures do not hide successful results.
- Operational dashboard retains real metrics, chart data, shortcuts and honest empty/error states.
- Approvals support list, board and month/week/day calendar views. Board moves open the existing review form and require a decision before saving. No reverse transitions or invented scheduling APIs.
- Approval filters apply to the current paginated results. Calendar dates represent the loaded results, not the entire database. Pagination and scope are exposed in the interface.
- Contextual approval timeline uses request/decision timestamps and the existing comments API. Related document links open the existing record views.
- Shared split-screen layout across login, signup/email verification/MFA, password recovery/reset, invitations and session/access status pages.
- Existing authentication endpoints, MFA/backups, token handling, permissions and logout remain connected. Passwords are never persisted by the new UI. Redirect destinations are restricted to local paths.
- Protected pages wait for startup validation before appearing. Cached access tokens are checked using `/auth/me`; the existing interceptor refreshes expired tokens. This avoids unnecessary cookie rotation on every page load and fixes a reproduced sign-out during rapid protected/public navigation.
- Mobile forms use a single column; contextual navigation, board and calendar content scroll inside their containers. Reduced-motion preferences are respected.

## Verification

- Frontend: 75 tests across 27 files passed, including login/MFA, startup validation, redirect validation, record search, approval board/calendar and document links.
- Backend: 835 tests across 132 suites passed. One suite and 10 tests were skipped by their existing configuration; skipped coverage is not counted as passing.
- TypeScript checks for web/API, full repository ESLint and the shared-types/API/web production build passed.
- Live browser: logout, real demo sign-in, return to requested protected route, session persistence after reload, launcher, populated record search and approval view switching checked. Consecutive searches on the same module keep the list query in sync, and closing a linked panel removes its record parameter.
- Browser route smoke checks passed for 29 module routes, including products, warehouse, purchasing, sales, contacts, reports, approvals, settings, supplier portal and automation. Automation now uses the shared application shell.
- Desktop and 390px mobile checks confirmed Manrope and no page-level horizontal overflow on the checked dashboard, recovery and approval layouts.

## External configuration and coverage limits

The local SMTP configuration rejects authentication, so real recovery/verification email delivery needs working mail credentials. No emails, payments, business approvals, password resets or production records were submitted during browser QA. Live MFA enrollment was not changed; MFA behavior is covered by frontend/backend tests. Unconfigured OAuth providers are not displayed. Populated mock records were checked in the browser; external delivery, production payments and destructive operations still need separate acceptance testing. The database, sample-data pack and loader scripts are excluded from this PR.

The only API behavior change is a dashboard month-bucket correction: UTC month starts avoid timezone shifts and short-month rollover. The existing endpoint and response contract are unchanged, and a regression test covers the boundary.

## Screenshots

These captures use synthetic local records and contain no credentials.

- [Dashboard](enterprise-ui-screenshots/dashboard.png)
- [Approval Kanban](enterprise-ui-screenshots/kanban.png)
- [Analytics](enterprise-ui-screenshots/analytics.png)
- [Login](enterprise-ui-screenshots/login.png)
