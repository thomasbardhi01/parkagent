-- Reliability 3/4: link jobs run from a DB-backed worker (they survive a
-- restart, retry with backoff, and dead-letter after the last attempt), and
-- Sign in with Apple revocation retries back off and dead-letter too.
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "apple_revoke_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "apple_revoke_dead_at" TIMESTAMPTZ(6),
ADD COLUMN     "apple_revoke_last_error" TEXT,
ADD COLUMN     "apple_revoke_next_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "link_jobs" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dead_at" TIMESTAMPTZ(6),
ADD COLUMN     "finished_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "locked_until" TIMESTAMPTZ(6),
ADD COLUMN     "max_attempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "next_attempt_at" TIMESTAMPTZ(6),
ADD COLUMN     "notified_at" TIMESTAMPTZ(6),
ADD COLUMN     "notify" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "queue_position" INTEGER,
ADD COLUMN     "set_up_card" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stages" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "started_at" TIMESTAMPTZ(6),
ADD COLUMN     "state_sealed" TEXT;

-- CreateIndex
CREATE INDEX "link_jobs_next_attempt_at_idx" ON "link_jobs"("next_attempt_at");

