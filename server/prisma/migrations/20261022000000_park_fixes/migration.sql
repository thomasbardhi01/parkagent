-- Park traces (K): every /location fix a park read, refused ones included
-- with why, kept 30 days. Additive: one new table.
-- CreateTable
CREATE TABLE "park_fixes" (
    "id" TEXT NOT NULL,
    "pending_park_id" TEXT NOT NULL,
    "measured_at" TIMESTAMPTZ(6) NOT NULL,
    "reported_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy_m" DOUBLE PRECISION NOT NULL,
    "speed_mps" DOUBLE PRECISION,
    "event" TEXT,
    "motion_activity" TEXT,
    "motion_confidence" TEXT,
    "bt_hint" TEXT,
    "rejected" TEXT,

    CONSTRAINT "park_fixes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "park_fixes_pending_park_id_received_at_idx" ON "park_fixes"("pending_park_id", "received_at");

-- CreateIndex
CREATE INDEX "park_fixes_received_at_idx" ON "park_fixes"("received_at");

-- AddForeignKey
ALTER TABLE "park_fixes" ADD CONSTRAINT "park_fixes_pending_park_id_fkey" FOREIGN KEY ("pending_park_id") REFERENCES "pending_parks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

