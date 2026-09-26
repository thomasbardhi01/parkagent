-- Per-user spending limits (GET/PUT /me/limits). Additive: no row means
-- the operator's policy.json defaults, exactly as before.
-- CreateTable
CREATE TABLE "user_limits" (
    "user_id" TEXT NOT NULL,
    "session_cap_usd" DECIMAL(6,2),
    "daily_cap_usd" DECIMAL(6,2),
    "default_stay_minutes" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_limits_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "user_limits" ADD CONSTRAINT "user_limits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

