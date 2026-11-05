# Google-first paid onboarding

This flow is isolated from the existing trial wizard and password login. Public Pro/Plus links start `/signup/google`; returning Google users can select **Sign in with Google** on the login page. The backend uses Google's official `google-auth-library` authorization-code implementation with `openid email profile`, S256 PKCE, nonce, state and server-side token verification. No Google access/refresh tokens are persisted.

## Local setup

1. Apply migrations and regenerate Prisma: `npx prisma migrate deploy --schema apps/api/prisma/schema.prisma` and `npm run prisma:generate --workspace=api`.
2. In Google Cloud create a Web application OAuth client. Register exactly `http://127.0.0.1:5200/api/v1/auth/onboarding/google/callback`. A `localhost` URL is different; use the exact host consistently. Configure the Google consent screen/test users as appropriate.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` and `APP_BASE_URL=http://127.0.0.1:5200` in the API's untracked environment. Use HTTPS origins and the corresponding exact callback for production. Never put the client secret in a `VITE_` variable or in Git.
4. Configure existing `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`. Start with Razorpay test mode. Register the existing signed webhook `/api/v1/billing/webhooks/razorpay` for payment captured/failed and refund processed events. Local webhook delivery requires a development tunnel or delivery tooling; localhost is not reachable by Razorpay.
5. Restart the API. Visit local pricing and select Pro or Plus. Missing credentials fail safely; no test identity or payment is simulated by the running application.

The checkout uses the existing one-off order integration, **not automatic recurring subscription debits**. The UI discloses manual renewal and the duration of access. Current server pricing has zero additional tax, matching existing checkout/invoice behavior. Tax or recurring-billing changes require a separate configured pricing policy; do not describe this as automatic renewal.

## Security and states

- Server-controlled `SignupIntent` stores the plan, interval, price/version, expiry, transaction hashes, identity association, tenant and payment reference. Ten-minute OAuth exchange window and one-hour onboarding window. Browser capability is a random HttpOnly, same-site cookie, stored hashed; mutation endpoints also require existing double-submit CSRF protection. The capability rotates after Google authentication and is consumed before full-session issuance.
- States: `OAUTH_PENDING → GOOGLE_AUTHENTICATED → WORKSPACE_SETUP_PENDING/CHECKOUT_PENDING → PAYMENT_PENDING → PAYMENT_VERIFIED → SUBSCRIPTION_ACTIVE`. Account creation/linking is transactional. Cancellation, expiry and failure are terminal. Intermediate claim states are only visible inside transactional processing. Replayed OAuth callbacks cannot exchange a code again.
- Google subject is unique. Matching email alone does not link accounts: the existing password is required and existing MFA remains enforced. Disabled, deleted or locked identities are rejected. Concurrent duplicate creation fails closed; starting a fresh flow safely resolves the unique identity.
- Only a workspace name and explicit acceptance of Terms/Privacy are required to create the tenant. Company name is optional; Google profile names are never treated as company names. Other business fields are left empty for Settings.
- New owners/admins enroll an authenticator separately after Google/workspace setup. Existing MFA users must verify TOTP or a single-use backup code. Existing encrypted secrets, hashed backup codes, lockout and recovery procedures are reused. Factor verification for onboarding issues no ERP session; challenge/backup-code consumption uses atomic claims. Pending Google accounts have an explicit session gate that also blocks password recovery/login and bearer tokens until verified payment clears it.
- Existing workspace membership is rechecked before checkout, payment activation and full-session issuance. Only workspace owners/admins may purchase a plan. Cross-tenant or downgrade attempts fail closed.
- Checkout serializes order creation per intent. It reuses the existing provider order across retries. Payment activation checks the checkout signature or signed raw webhook, then fetches the payment from Razorpay and validates captured status, order, amount and INR currency. Intent/payment consumption and plan activation are transactional. Duplicate callbacks cannot extend access twice.
- Generic legacy payment activation explicitly excludes onboarding orders, and its verification endpoint now also requires captured status/amount from Razorpay. New paid registrations are rejected by the old signup-request endpoint; preexisting staged signup records and trial registration remain compatible. A successful browser redirect or an unverified client payload cannot activate an intent.
- New pending tenants use an expired, suspended trial with no paid entitlement. Suspended/expired subscriptions are enforced by backend feature checks as well as write guards, retaining the configured existing expiration grace period.
- Password recovery also expires all onboarding capabilities, consumes outstanding MFA challenges and revokes trusted devices, alongside the existing session revocation. A recovered unfinished Google account must resume a fresh Google signup flow before receiving ERP access.
- Verified refunds suspend the latest entitlement purchase, with idempotent processing. Cancelling the browser flow does not cancel an already paid subscription. Failed/dismissed checkout leaves paid features locked and allows the same order to be retried during the intent lifetime. A payment received after intent expiry does not activate access; support must reconcile/refund it. There is no recurring-subscription cancellation API in the existing gateway integration.

## Verification boundaries

Automated tests use locally signed test ID tokens and the real Google library's signature/issuer/audience/expiry verifier; no external Google account is impersonated. Provider calls are mocked only in isolated automated tests. Backend tests exercise state replay, plan validation, account linking, MFA requirements, tenant membership, intent expiry and payment binding. Existing MFA/recovery tests cover hashed and one-time backup code behavior.

Live Google consent/account selection, provider checkout, webhook delivery, real refunds and password-account linking need configured test credentials and separate end-to-end acceptance testing. Do not claim production readiness solely from mocked provider tests. Review OAuth consent configuration, trusted proxy/origin configuration, security monitoring and production tax settings before deployment.

### Local verification, 3 November 2026

- Full API regression run: 138 suites / 916 tests passed, with 1 suite / 10 existing tests skipped. After final legacy signup/payment and recovery hardening, all 102 tests in the 10 affected security suites passed.
- Frontend: 28 files / 85 tests passed. Existing Playwright login/mobile/purchasing/report checks: all 8 passed.
- Repository lint, web TypeScript and production builds passed. Both additive migrations applied, and a database-to-schema diff reported no difference.
- Live requests rejected a client-supplied payment amount, missing CSRF, a missing onboarding session and unauthenticated product access. Missing provider configuration returned a safe unavailable result. Browser checks confirmed both legacy Pro/Plus signup URLs redirect to the Google entry screen, no six-step form is shown, and the 390px layout has no horizontal page overflow or console errors.
- Local Google and Razorpay credentials/webhook configuration are absent. Real provider success flows have **not** been verified, and the feature must not be represented as ready for production activation until those acceptance checks pass.

References: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [official Node library](https://github.com/googleapis/google-cloud-node-core/tree/main/packages/google-auth-library).
