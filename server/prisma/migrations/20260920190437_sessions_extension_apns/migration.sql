-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "car_lat" DOUBLE PRECISION,
ADD COLUMN     "car_lng" DOUBLE PRECISION,
ADD COLUMN     "charged_minutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "extend_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "hours_json" JSONB,
ADD COLUMN     "last_extender_rule" TEXT,
ADD COLUMN     "last_extender_rule_at" TIMESTAMPTZ(6),
ADD COLUMN     "max_stay_minutes" INTEGER,
ADD COLUMN     "parked_event_id" TEXT,
ADD COLUMN     "purchased_minutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rate_additional_hour" DECIMAL(6,2),
ADD COLUMN     "rate_first_hour" DECIMAL(6,2),
ADD COLUMN     "stopped_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "session_events" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "minutes" INTEGER,
    "amount_usd" DECIMAL(6,2),
    "fee_usd" DECIMAL(6,2),
    "expires_at" TIMESTAMPTZ(6),
    "provider_session_id" TEXT,
    "dry_run" BOOLEAN NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_fixes" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy_m" DOUBLE PRECISION NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_fixes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_events_session_id_at_idx" ON "session_events"("session_id", "at");

-- CreateIndex
CREATE INDEX "location_fixes_session_id_ts_idx" ON "location_fixes"("session_id", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");

-- CreateIndex
CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens"("user_id");

-- CreateIndex
CREATE INDEX "sessions_status_idx" ON "sessions"("status");

-- AddForeignKey
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_fixes" ADD CONSTRAINT "location_fixes_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
