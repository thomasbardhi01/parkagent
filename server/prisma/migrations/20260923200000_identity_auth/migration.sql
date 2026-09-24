-- Identity + sessions: users grow real sign-in identity (email / Apple /
-- Google subjects, tombstone), refresh_tokens carries the app's rotating
-- session families, email_login_codes the 6-digit email sign-in codes, and
-- provider_accounts remembers the brand/last4 of the user's own card on the
-- provider (display only — never the PAN).

-- AlterTable users
ALTER TABLE "users" ADD COLUMN "email" TEXT;
ALTER TABLE "users" ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "phone" TEXT;
ALTER TABLE "users" ADD COLUMN "phone_verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "apple_sub" TEXT;
ALTER TABLE "users" ADD COLUMN "google_sub" TEXT;
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_apple_sub_key" ON "users"("apple_sub");
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");

-- AlterTable provider_accounts
ALTER TABLE "provider_accounts" ADD COLUMN "card_brand" TEXT;
ALTER TABLE "provider_accounts" ADD COLUMN "card_last4" TEXT;

-- CreateTable refresh_tokens
CREATE TABLE "refresh_tokens" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "family_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "device_id" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "rotated_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateTable email_login_codes
CREATE TABLE "email_login_codes" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "consumed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_login_codes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_login_codes_email_created_at_idx" ON "email_login_codes"("email", "created_at");
