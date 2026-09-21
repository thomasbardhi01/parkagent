-- Authorization, not just authentication: policy edits and /admin/* need
-- an admin user. Existing users stay non-admin; flip the owner with
-- create:user --admin (new users) or:
--   UPDATE users SET is_admin = true WHERE name = '<owner>';
ALTER TABLE "users" ADD COLUMN "is_admin" BOOLEAN NOT NULL DEFAULT false;
