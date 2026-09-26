-- Saved assistant conversations: the app lists them (newest first, titled by
-- the first request), opens them to resume, and deletes them. `turns` is the
-- model's context and is trimmed to the last 20 messages, so the list keeps
-- its own record: the title, set once from the first request, and `display`,
-- the readable transcript ({role, text, at, planId?, suggestions?}).
ALTER TABLE "conversations" ADD COLUMN "title" TEXT;
ALTER TABLE "conversations" ADD COLUMN "display" JSONB NOT NULL DEFAULT '[]';

-- What the user did with a plan: the option they confirmed (null for an
-- itinerary sign-off) and when. The history list and Activity read it.
ALTER TABLE "assistant_plans" ADD COLUMN "confirmed_at" TIMESTAMPTZ(6);
ALTER TABLE "assistant_plans" ADD COLUMN "confirmed_option_id" TEXT;
CREATE INDEX "assistant_plans_conversation_id_idx" ON "assistant_plans"("conversation_id");
