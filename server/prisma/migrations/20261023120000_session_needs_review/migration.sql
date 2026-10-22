-- The receipt bound (D0 Q3): a start whose provider receipt disagrees with
-- the price records the price and flags the session for a person to look
-- at. Additive: one column with a default, so existing rows read false.
-- AlterTable
ALTER TABLE "sessions" ADD COLUMN "needs_review" BOOLEAN NOT NULL DEFAULT false;
