-- When the phone measured a session fix (the app's `measuredAt`, else its
-- `ts`): the clock the lifecycle reads every walk rule on, so the extension
-- worker reads freshness on it too (fixCountsFor). Additive and nullable:
-- older rows have only `ts`, which readers fall back to.
ALTER TABLE "location_fixes" ADD COLUMN "measured_at" TIMESTAMPTZ(6);
