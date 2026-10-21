-- The return dwell's own clock (#226): a minute of fixes at the car even
-- allowing for their error, apart from near_since (any usable fix within
-- 30 m), which only holds. Additive: one nullable column.
-- AlterTable
ALTER TABLE "pending_parks" ADD COLUMN "at_car_since" TIMESTAMPTZ(6);
