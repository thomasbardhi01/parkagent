-- Conversational assistant + Link wallet for agents.
-- Conversations hold the model's last-20-turn history; plans are what the
-- client rendered; confirmations are the single-use sign-off tokens that
-- gate every booking/spend; itineraries are signed-off multi-stop days;
-- link_accounts / link_spend_requests are the Stripe Link wallet surface
-- (tokens and one-time cards sealed with PROVIDER_STATE_KEY crypto).

CREATE TABLE "conversations" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "turns" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "conversations_user_id_updated_at_idx" ON "conversations"("user_id", "updated_at");

CREATE TABLE "assistant_plans" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "plan" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assistant_plans_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "assistant_plans_user_id_created_at_idx" ON "assistant_plans"("user_id", "created_at");

CREATE TABLE "assistant_confirmations" (
  "token" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL,
  "option_id" TEXT,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assistant_confirmations_pkey" PRIMARY KEY ("token")
);
CREATE INDEX "assistant_confirmations_user_id_created_at_idx" ON "assistant_confirmations"("user_id", "created_at");

CREATE TABLE "itineraries" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "plan_id" TEXT,
  "status" TEXT NOT NULL,
  "date" TIMESTAMPTZ(6) NOT NULL,
  "stops" JSONB NOT NULL,
  "total_usd" DECIMAL(8,2) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "itineraries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "itineraries_user_id_date_idx" ON "itineraries"("user_id", "date");

CREATE TABLE "link_accounts" (
  "user_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "tokens_encrypted" TEXT,
  "connected_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "link_accounts_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE "link_spend_requests" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "itinerary_id" TEXT,
  "stop_id" TEXT,
  "plan_id" TEXT,
  "amount_usd" DECIMAL(8,2) NOT NULL,
  "status" TEXT NOT NULL,
  "approval_url" TEXT,
  "card_encrypted" TEXT,
  "valid_until" TIMESTAMPTZ(6),
  "card_used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "link_spend_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "link_spend_requests_user_id_created_at_idx" ON "link_spend_requests"("user_id", "created_at");

-- Which source pays a session: issuing_card (default) or link_wallet.
ALTER TABLE "sessions" ADD COLUMN "payment_source" TEXT NOT NULL DEFAULT 'issuing_card';
