-- The street session lifecycle's record (FR-55): one row per detected
-- street park, from /parked to its end. Additive: a new table, nothing
-- else changes, and a park with no row behaves exactly as before.
-- CreateTable
CREATE TABLE "pending_parks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "parked_event_id" TEXT,
    "status" TEXT NOT NULL,
    "candidates" JSONB,
    "quote" JSONB,
    "prompt" JSONB,
    "zone_id" TEXT,
    "car_lat" DOUBLE PRECISION NOT NULL,
    "car_lng" DOUBLE PRECISION NOT NULL,
    "parked_at" TIMESTAMPTZ(6) NOT NULL,
    "left_car_at" TIMESTAMPTZ(6),
    "far_at" TIMESTAMPTZ(6),
    "near_since" TIMESTAMPTZ(6),
    "prompted_at" TIMESTAMPTZ(6),
    "confirmed_at" TIMESTAMPTZ(6),
    "starting_at" TIMESTAMPTZ(6),
    "session_id" TEXT,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pending_parks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pending_parks_parked_event_id_key" ON "pending_parks"("parked_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "pending_parks_session_id_key" ON "pending_parks"("session_id");

-- CreateIndex
CREATE INDEX "pending_parks_user_id_status_idx" ON "pending_parks"("user_id", "status");
