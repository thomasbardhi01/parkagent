-- Garage and lot footprints (FR-49): one outline per row, beside zones.
-- Loaded per city by `pnpm -C server load:garages` from
-- data/out/<city>_garages.geojson. Additive: a new table, nothing altered.
-- PostGIS already exists (the zones migration creates the extension).

-- CreateTable
CREATE TABLE "garages" (
    "id" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "name" TEXT,
    "operator" TEXT,
    "kind" TEXT NOT NULL,
    "fee" BOOLEAN,
    "access" TEXT,
    "capacity" INTEGER,
    "website" TEXT,
    "geom" geometry(Polygon, 4326) NOT NULL,
    "entrances" geometry(MultiPoint, 4326) NOT NULL,
    "source" TEXT NOT NULL,
    "source_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "garages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "garages_geom_idx" ON "garages" USING GIST ("geom");

-- CreateIndex
CREATE INDEX "garages_city_source_idx" ON "garages"("city", "source");
