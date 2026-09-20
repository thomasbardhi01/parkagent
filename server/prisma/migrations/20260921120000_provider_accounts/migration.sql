-- CreateTable
CREATE TABLE "provider_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "state_encrypted" TEXT,
    "linked_at" TIMESTAMPTZ(6),
    "last_verified_at" TIMESTAMPTZ(6),
    "card_added" BOOLEAN NOT NULL DEFAULT false,
    "wallet_balance_cents" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provider_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_accounts_user_id_provider_key" ON "provider_accounts"("user_id", "provider");
