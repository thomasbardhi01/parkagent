-- Device tokens are bound to their user: deleting a user must not leave
-- an orphaned push channel behind (audit finding #74). Route-level checks
-- stop cross-user rebinding; the FK handles user deletion.
ALTER TABLE "device_tokens"
  ADD CONSTRAINT "device_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
