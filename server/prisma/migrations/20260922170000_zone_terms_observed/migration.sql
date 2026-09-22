-- Zone terms as the provider's own UI displayed them (Passport's Vehicles
-- chooser carries a "Zone Information" line), keyed by pay-by-app zone
-- number per city. Quoting prefers these over the dataset when present:
-- the Boston dataset assumed a 2-hour max everywhere, but e.g. zone 456 is
-- posted 5 hours. No FK to zones: zone rows are replaced on every
-- load:zones run and observations must survive it.
CREATE TABLE "zone_terms_observed" (
    "city" TEXT NOT NULL,
    "zone_number" TEXT NOT NULL,
    "rate_per_hour_usd" DECIMAL(6,2),
    "max_stay_minutes" INTEGER,
    "raw_text" TEXT NOT NULL,
    "hours_json" JSONB,
    "zone_id" TEXT,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zone_terms_observed_pkey" PRIMARY KEY ("city","zone_number")
);
