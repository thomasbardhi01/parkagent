-- Chained link → setup-card jobs move from process memory to the DB so a
-- deploy/restart mid-job doesn't lose them; the link-job janitor fails
-- rows stuck in progress past 15 minutes with reason "timeout".
CREATE TABLE "link_jobs" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "reason" TEXT,
  "retry_safe" BOOLEAN,
  "dry_run" BOOLEAN,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "link_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "link_jobs_phase_created_at_idx" ON "link_jobs"("phase", "created_at");
