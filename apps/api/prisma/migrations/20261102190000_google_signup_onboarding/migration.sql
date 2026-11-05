-- CreateEnum
CREATE TYPE "SignupIntentStatus" AS ENUM ('OAUTH_PENDING', 'GOOGLE_AUTHENTICATED', 'ACCOUNT_CREATED', 'WORKSPACE_SETUP_PENDING', 'CHECKOUT_PENDING', 'PAYMENT_PENDING', 'PAYMENT_VERIFIED', 'SUBSCRIPTION_ACTIVE', 'CANCELLED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "oauth_accounts" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_subject" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "verified_email" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signup_intents" (
    "login_only" BOOLEAN NOT NULL DEFAULT false,
    "id" UUID NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "billing_cycle" "BillingCycle" NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "pricing_version" TEXT NOT NULL,
    "status" "SignupIntentStatus" NOT NULL DEFAULT 'OAUTH_PENDING',
    "session_hash" TEXT NOT NULL,
    "state_hash" TEXT NOT NULL,
    "nonce_hash" TEXT NOT NULL,
    "pkce_verifier" TEXT,
    "oauth_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "user_id" UUID,
    "company_id" UUID,
    "google_subject" TEXT,
    "verified_email" TEXT,
    "profile_name" TEXT,
    "profile_picture" TEXT,
    "security_verified_at" TIMESTAMPTZ(6),
    "link_attempts" INTEGER NOT NULL DEFAULT 0,
    "order_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "signup_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_accounts_provider_provider_subject_key" ON "oauth_accounts"("provider", "provider_subject");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_accounts_user_id_provider_key" ON "oauth_accounts"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "signup_intents_session_hash_key" ON "signup_intents"("session_hash");

-- CreateIndex
CREATE UNIQUE INDEX "signup_intents_state_hash_key" ON "signup_intents"("state_hash");

-- CreateIndex
CREATE UNIQUE INDEX "signup_intents_order_id_key" ON "signup_intents"("order_id");

-- CreateIndex
CREATE INDEX "signup_intents_expires_at_idx" ON "signup_intents"("expires_at");

-- CreateIndex
CREATE INDEX "signup_intents_user_id_idx" ON "signup_intents"("user_id");

-- AddForeignKey
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signup_intents" ADD CONSTRAINT "signup_intents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signup_intents" ADD CONSTRAINT "signup_intents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
