-- PostGIS must exist before the geometry columns below. Neon ships it;
-- CREATE EXTENSION is idempotent and needs no superuser there.
CREATE EXTENSION IF NOT EXISTS postgis;

-- CreateTable
CREATE TABLE "zones" (
    "zone_id" TEXT NOT NULL,
    "parknyc_zone_number" TEXT NOT NULL,
    "vehicle_type" TEXT NOT NULL,
    "passenger" BOOLEAN NOT NULL,
    "rate_first_hour" DECIMAL(6,2) NOT NULL,
    "rate_additional_hour" DECIMAL(6,2) NOT NULL,
    "max_stay_minutes" INTEGER,
    "hours_json" JSONB NOT NULL,
    "geom" geometry(MultiPolygon, 4326) NOT NULL,
    "centerline" geometry(MultiLineString, 4326) NOT NULL,
    "data_version" TEXT NOT NULL,
    "loaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("zone_id")
);

-- CreateTable
CREATE TABLE "zone_loads" (
    "id" SERIAL NOT NULL,
    "loaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data_version" TEXT NOT NULL,
    "source_datasets" JSONB NOT NULL,
    "zone_count" INTEGER NOT NULL,
    "passenger_only" BOOLEAN NOT NULL,

    CONSTRAINT "zone_loads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "zones_geom_idx" ON "zones" USING GIST ("geom");

-- CreateIndex
CREATE INDEX "zones_centerline_idx" ON "zones" USING GIST ("centerline");
