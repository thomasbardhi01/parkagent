-- WS-4 PR 2a: agent keys, and the assistant's confirmation token as the
-- one mandate every surface mints and consumes (app, REST, MCP).
-- Additive-safe: renames and nullable columns, no data rewritten. Rows in
-- flight at deploy keep their plaintext token and can't be consumed (the
-- token is stored hashed from now on); they expire within ten minutes.

-- RenameTable
ALTER TABLE "assistant_confirmations" RENAME TO "mandates";
ALTER TABLE "mandates" RENAME COLUMN "used_at" TO "consumed_at";
ALTER INDEX "assistant_confirmations_pkey" RENAME TO "mandates_pkey";
ALTER INDEX "assistant_confirmations_user_id_created_at_idx" RENAME TO "mandates_user_id_created_at_idx";

-- AlterTable: who holds it and what it binds (null on the app's own taps).
ALTER TABLE "mandates" ADD COLUMN "agent_key_id" TEXT;
ALTER TABLE "mandates" ADD COLUMN "plan_hash" TEXT;
ALTER TABLE "mandates" ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "mandates" ADD COLUMN "caps_snapshot" JSONB;

-- CreateTable: a person's keys for external agents. The key itself is
-- shown once; only its hash (API_KEY_PEPPER) and prefix are kept.
CREATE TABLE "agent_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "agent_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_keys_hash_key" ON "agent_keys"("hash");
CREATE INDEX "agent_keys_user_id_idx" ON "agent_keys"("user_id");

-- AddForeignKey
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
