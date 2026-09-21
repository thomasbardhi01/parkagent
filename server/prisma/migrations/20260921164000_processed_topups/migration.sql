-- Idempotency for Apple Pay top-ups: a redelivered
-- payment_intent.succeeded used to repeat moveToFinancialAccount and
-- move the money twice. One row per processed intent; a second delivery
-- finds it and skips.
CREATE TABLE "processed_topups" (
  "payment_intent_id" TEXT NOT NULL,
  "amount_usd" DECIMAL(8,2) NOT NULL,
  "user_id" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "processed_topups_pkey" PRIMARY KEY ("payment_intent_id")
);
