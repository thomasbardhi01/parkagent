-- The pay-by-app zone number is provider-generic now (ParkNYC for nyc,
-- ParkBoston for bos), and Boston numbers come from user reports at the
-- meter — the ParkBoston web app has no map to resolve them from
-- (2026-09-21 recording).

ALTER TABLE "zones" RENAME COLUMN "parknyc_zone_number" TO "provider_zone_number";
ALTER TABLE "sessions" RENAME COLUMN "parknyc_zone_number" TO "provider_zone_number";

ALTER TABLE "zones" ADD COLUMN "provider_zone_number_verified" BOOLEAN NOT NULL DEFAULT false;

-- One row per (zone, user); the zone's provider_zone_number mirrors the
-- latest report. No FK to zones: zone rows are replaced on every
-- load:zones run and reports must survive it.
CREATE TABLE "zone_number_reports" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zone_number_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "zone_number_reports_zone_id_user_id_key" ON "zone_number_reports"("zone_id", "user_id");
CREATE INDEX "zone_number_reports_zone_id_idx" ON "zone_number_reports"("zone_id");
