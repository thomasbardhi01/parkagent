-- One open (pending or active) session per user, enforced by the database:
-- the route's find-then-create check has a window where two concurrent
-- /session/start calls could both pass and both pay the meter. The second
-- insert now fails P2002 and the route answers 409 session_already_active.
CREATE UNIQUE INDEX IF NOT EXISTS "one_open_session_per_user"
  ON "sessions" ("user_id")
  WHERE "status" IN ('pending', 'active');
