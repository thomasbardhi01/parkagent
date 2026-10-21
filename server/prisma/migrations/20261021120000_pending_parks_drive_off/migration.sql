-- Drive-off after a return (#226): the phone back at the car, then gone
-- from it faster than anyone walks. Additive: four nullable columns on
-- pending_parks, and a row without them behaves as before.
-- AlterTable
ALTER TABLE "pending_parks" ADD COLUMN "back_at" TIMESTAMPTZ(6),
ADD COLUMN "drive_at" TIMESTAMPTZ(6),
ADD COLUMN "drive_distance_m" DOUBLE PRECISION,
ADD COLUMN "drive_speed_mps" DOUBLE PRECISION;
