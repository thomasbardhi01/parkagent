-- WS-4 E3: an agent's confirmed street plan is bound, once, to the park
-- the phone reports at its spot inside the mandate's window. Additive:
-- two nullable columns and a unique index (a plan binds one park, a park
-- one plan).
-- AlterTable
ALTER TABLE "assistant_plans" ADD COLUMN "bound_parked_event_id" TEXT;
ALTER TABLE "assistant_plans" ADD COLUMN "bound_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE UNIQUE INDEX "assistant_plans_bound_parked_event_id_key" ON "assistant_plans"("bound_parked_event_id");
