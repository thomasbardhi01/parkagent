-- CreateTable
CREATE TABLE "issuing_cardholders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "stripe_cardholder_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "issuing_cardholders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issuing_cards" (
    "id" TEXT NOT NULL,
    "cardholder_id" TEXT NOT NULL,
    "stripe_card_id" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "per_auth_cap_usd" DECIMAL(6,2) NOT NULL,
    "daily_cap_usd" DECIMAL(6,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "issuing_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issuing_authorizations" (
    "id" TEXT NOT NULL,
    "stripe_authorization_id" TEXT NOT NULL,
    "stripe_card_id" TEXT NOT NULL,
    "user_id" TEXT,
    "amount_usd" DECIMAL(8,2) NOT NULL,
    "merchant_category" TEXT,
    "merchant_category_code" TEXT,
    "merchant_name" TEXT,
    "approved" BOOLEAN NOT NULL,
    "decision" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "stripe_transaction_id" TEXT,
    "captured_usd" DECIMAL(8,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "issuing_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "issuing_cardholders_user_id_key" ON "issuing_cardholders"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "issuing_cardholders_stripe_cardholder_id_key" ON "issuing_cardholders"("stripe_cardholder_id");

-- CreateIndex
CREATE UNIQUE INDEX "issuing_cards_stripe_card_id_key" ON "issuing_cards"("stripe_card_id");

-- CreateIndex
CREATE UNIQUE INDEX "issuing_authorizations_stripe_authorization_id_key" ON "issuing_authorizations"("stripe_authorization_id");

-- CreateIndex
CREATE UNIQUE INDEX "issuing_authorizations_stripe_transaction_id_key" ON "issuing_authorizations"("stripe_transaction_id");

-- CreateIndex
CREATE INDEX "issuing_authorizations_user_id_created_at_idx" ON "issuing_authorizations"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "issuing_cards" ADD CONSTRAINT "issuing_cards_cardholder_id_fkey" FOREIGN KEY ("cardholder_id") REFERENCES "issuing_cardholders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
