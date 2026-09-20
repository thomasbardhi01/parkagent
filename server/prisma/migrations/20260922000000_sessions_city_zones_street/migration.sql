-- Sessions carry their city (from the zone at start) so the extension
-- worker prices ticket risk and fees per city without re-reading zones.
ALTER TABLE "sessions" ADD COLUMN "city" TEXT NOT NULL DEFAULT 'nyc';

-- Zones carry their street (Boston: Analyze Boston's STREET grouping) —
-- the Passport executor's zone_mismatch guard compares the provider map's
-- street against this. Null for rows loaded before the builder carried it.
ALTER TABLE "zones" ADD COLUMN "street" TEXT;
