-- The receipt bound, review round 1 (#286): what a provider's receipt said
-- beyond what the session recorded (it never records above what was
-- shown), so the per-stop and daily caps count it on top. Additive: one
-- nullable column; existing rows read null, which counts nothing.
-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "receipt_excess_usd" DECIMAL(10,2);
