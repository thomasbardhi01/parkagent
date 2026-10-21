-- Who acted (WS-4 PR 1): every decisions row says whether a person, the
-- owner's admin key, a background job, or an external agent made it, and
-- which agent key when one did. Additive: a default and a nullable
-- column, so a script writing past the one decision writer stays correct.
-- AlterTable
ALTER TABLE "decisions" ADD COLUMN "actor" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "decisions" ADD COLUMN "agent_key_id" TEXT;

-- Consent for an external agent to act on the account; off until the
-- person turns it on. Checked only when the actor is an external agent.
-- AlterTable
ALTER TABLE "users" ADD COLUMN "agents_may_act" BOOLEAN NOT NULL DEFAULT false;
