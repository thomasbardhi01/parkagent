-- Idempotency keys: one answer per (user, key) for unsafe requests; kept 24 h.
-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "status_code" INTEGER,
    "response" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_key_key" ON "idempotency_keys"("user_id", "key");

