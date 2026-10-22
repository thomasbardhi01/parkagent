-- The user's newest park since a time: read on every move of a park to
-- started and before every extension the worker buys (#246).
CREATE INDEX "parked_events_user_id_ts_idx" ON "parked_events"("user_id", "ts");
