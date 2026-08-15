-- R-031: the job a tenant is being billed for (MAINT-07; D-11).
--
-- `WorkOrder.tenantCaused` has existed since R-002 and its own schema comment
-- says it "drives the mid-lease chargeback flow". Nothing consumed it: the
-- flag was set at close and the tenant was never billed. This is the column
-- that joins the two, and it is deliberately the same shape as
-- `utilityBillId` one migration family over - a charge that moves money on
-- the strength of evidence stores a key to that evidence.
ALTER TABLE "Charge" ADD COLUMN "workOrderId" TEXT;

-- RESTRICT, like every other foreign key in this schema pointing at a row the
-- evidence trail depends on. The vendor's invoice and the completion photos
-- hang off this work order; deleting it would leave a tenant billed for a
-- repair the record can no longer describe, which is the exact position a
-- disputed chargeback must never be argued from.
ALTER TABLE "Charge"
  ADD CONSTRAINT "Charge_workOrderId_fkey"
  FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ONE CHARGEBACK PER JOB, enforced by the database.
--
-- Partial, because every other charge type leaves this column null and a
-- plain unique index would then allow exactly one charge in the whole table.
-- The same reasoning as `Charge_one_nsf_fee_per_payment`, and for the same
-- reason: the guard cannot live in application code. Two staff pressing
-- "post charge" on one job within the same second would both pass a
-- read-then-write check, and a tenant billed twice for one repair is a
-- support call that starts from a position of being wrong.
CREATE UNIQUE INDEX "Charge_one_chargeback_per_work_order"
  ON "Charge" ("workOrderId")
  WHERE "workOrderId" IS NOT NULL;

-- Reading the other way: "what has this job cost the tenant", asked by the
-- work order page every time it renders.
CREATE INDEX "Charge_workOrderId_idx" ON "Charge" ("workOrderId");
