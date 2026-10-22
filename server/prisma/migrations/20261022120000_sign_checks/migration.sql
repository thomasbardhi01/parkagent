-- Issue N: parking-sign checks, one per check the driver asks for at a
-- park. Additive: a new table only.
CREATE TABLE "sign_checks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "parked_event_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verdict" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "ocr_text" TEXT,
    "text_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "photo" BYTEA,
    "photo_media_type" TEXT,
    "photo_expires_at" TIMESTAMPTZ(6),
    "offer_max_stay_minutes" INTEGER,
    "accepted_at" TIMESTAMPTZ(6),

    CONSTRAINT "sign_checks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sign_checks_parked_event_id_idx" ON "sign_checks"("parked_event_id");

CREATE INDEX "sign_checks_user_id_idx" ON "sign_checks"("user_id");

ALTER TABLE "sign_checks" ADD CONSTRAINT "sign_checks_parked_event_id_fkey" FOREIGN KEY ("parked_event_id") REFERENCES "parked_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
