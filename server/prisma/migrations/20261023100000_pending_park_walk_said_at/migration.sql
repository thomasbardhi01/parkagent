-- The app's left_car refused at the car's door (#264): kept, so a later
-- fix that shows the phone off the car takes the walk-away it said.
-- Additive and nullable.
ALTER TABLE "pending_parks" ADD COLUMN "walk_said_at" TIMESTAMPTZ(6);
-- Whether that fix was usable (<= 65 m): only then does it place the phone
-- within the door's reach, and only then is a pace since it a pace.
ALTER TABLE "pending_parks" ADD COLUMN "walk_said_usable" BOOLEAN;
