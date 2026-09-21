-- API keys at rest become SHA-256(pepper:key). The hash needs the
-- API_KEY_PEPPER secret, so existing rows are converted by the
-- `pnpm -C server migrate:api-keys` script (which also nulls the
-- plaintext), not by this migration.
ALTER TABLE "users" ALTER COLUMN "api_key" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "api_key_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "api_key_prefix" TEXT;
CREATE UNIQUE INDEX "users_api_key_hash_key" ON "users"("api_key_hash");
