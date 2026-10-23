-- When the phone measured a session fix (the app's `measuredAt`, else its
-- `ts`): kept beside `ts` for the trace and the walk rules' clock. The
-- extension worker reads freshness on `ts` (the report time: a still
-- phone's heartbeat re-sends its last measurement). Additive and nullable:
-- older rows have only `ts`.
ALTER TABLE "location_fixes" ADD COLUMN "measured_at" TIMESTAMPTZ(6);
