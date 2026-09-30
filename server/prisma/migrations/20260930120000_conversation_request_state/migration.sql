-- The assistant's request as server-owned, versioned state (FR-42): the
-- place, the window, the user's limits and preferences, and a log of every
-- change. The model edits it only through update_request
-- (services/assistant/requestState.ts). Nullable and additive: a row saved
-- before it reads as the empty request.
ALTER TABLE "conversations" ADD COLUMN "request_state" JSONB;
