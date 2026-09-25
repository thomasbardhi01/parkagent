-- Wallet: three ways to pay (provider_card | link_wallet | parkagent_card),
-- the ParkAgent card funded per session by holds on the user's own card,
-- and the garage bookings the Activity tab lists.

-- The ParkAgent card's payment-source value is renamed issuing_card →
-- parkagent_card everywhere it is stored. Decisions keep their historical
-- inputs (an audit is not rewritten).
UPDATE "users" SET "payment_source" = 'parkagent_card' WHERE "payment_source" = 'issuing_card';
UPDATE "sessions" SET "payment_source" = 'parkagent_card' WHERE "payment_source" = 'issuing_card';
UPDATE "itineraries"
SET "stops" = replace("stops"::text, '"paymentSource": "issuing_card"', '"paymentSource": "parkagent_card"')::jsonb
WHERE "stops"::text LIKE '%"paymentSource": "issuing_card"%';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "stripe_customer_id" TEXT;

-- AlterTable
ALTER TABLE "sessions" ALTER COLUMN "payment_source" SET DEFAULT 'provider_card';

-- AlterTable
ALTER TABLE "link_accounts" ADD COLUMN     "pm_brand" TEXT,
ADD COLUMN     "pm_fetched_at" TIMESTAMPTZ(6),
ADD COLUMN     "pm_last4" TEXT,
ADD COLUMN     "pm_type" TEXT;

-- AlterTable
ALTER TABLE "link_spend_requests" ADD COLUMN     "approval_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "merchant_name" TEXT,
ADD COLUMN     "revealed_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "issuing_authorizations" ADD COLUMN     "hold_id" TEXT,
ADD COLUMN     "session_id" TEXT;

-- CreateTable
CREATE TABLE "funding_methods" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "stripe_payment_method_id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "exp_month" INTEGER,
    "exp_year" INTEGER,
    "wallet" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(6),

    CONSTRAINT "funding_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_holds" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "leg" TEXT NOT NULL,
    "payment_intent_id" TEXT,
    "funding_method_id" TEXT,
    "quote_usd" DECIMAL(8,2) NOT NULL,
    "amount_usd" DECIMAL(8,2) NOT NULL,
    "authorized_usd" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "captured_usd" DECIMAL(8,2),
    "status" TEXT NOT NULL,
    "decline_code" TEXT,
    "settled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "session_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "garage_bookings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan_id" TEXT,
    "itinerary_id" TEXT,
    "option_id" TEXT NOT NULL,
    "provider" TEXT,
    "label" TEXT NOT NULL,
    "price_usd" DECIMAL(8,2) NOT NULL,
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "deep_link" TEXT,
    "payment_source" TEXT NOT NULL,
    "link_spend_request_id" TEXT,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "garage_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "funding_methods_stripe_payment_method_id_key" ON "funding_methods"("stripe_payment_method_id");

-- CreateIndex
CREATE INDEX "funding_methods_user_id_idx" ON "funding_methods"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_holds_payment_intent_id_key" ON "session_holds"("payment_intent_id");

-- CreateIndex
CREATE INDEX "session_holds_user_id_created_at_idx" ON "session_holds"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "session_holds_status_created_at_idx" ON "session_holds"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "session_holds_session_id_leg_key" ON "session_holds"("session_id", "leg");

-- CreateIndex
CREATE INDEX "garage_bookings_user_id_created_at_idx" ON "garage_bookings"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_stripe_customer_id_key" ON "users"("stripe_customer_id");

