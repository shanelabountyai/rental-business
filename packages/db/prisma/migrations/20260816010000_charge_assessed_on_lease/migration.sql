-- R-050b (Golden Path 2 repair): a late fee needs somewhere to anchor when
-- the rent it is assessed on has no Charge row at all.
--
-- D-11/D-40 mint no monthly Charge for ordinary subscription-billed rent -
-- only the exceptions (a proration, a late fee, a chargeback) get one. That
-- is fine for READING delinquency: rentRoll()/delinquencyFor() already fall
-- back to a rentDueDay-derived date when no Charge exists (R-044/R-045).
-- It is not fine for WRITING a late fee: `assessedOnChargeId` is a real
-- foreign key, and there was nothing for unlinked rent to point at - so
-- assessLateFees() silently never fired on it at all, which is the common
-- case for every lease past its first month. Walking Demo checkpoint 2 is
-- what surfaced this (D-28).
--
-- `assessedOnLeaseId` is the alternative anchor for exactly that case.
-- `assessedForDueOn` records WHICH rent-due cycle the fee belongs to,
-- because unlike `assessedOnChargeId` (one row, one due date, forever),
-- unlinked rent is a single lease-wide balance that can represent a
-- DIFFERENT overdue cycle each time it is checked - this month's rent paid
-- off, next month's gone unpaid. Without it, a fee assessed against last
-- month's debt would be read as "already assessed" against a completely
-- different debt next month, and the delta math would zero out a fee that
-- is genuinely owed. `Charge.dueOn` itself cannot serve this purpose - it is
-- already the day the FEE was assessed (today), not the day the rent it
-- answers to was due (see late-fees.ts's own header).
ALTER TABLE "Charge" ADD COLUMN "assessedOnLeaseId" TEXT;
ALTER TABLE "Charge" ADD COLUMN "assessedForDueOn" DATE;

-- RESTRICT, like every other evidence-trail key in this schema: the lease a
-- fee was assessed against cannot be deleted out from under the fee.
ALTER TABLE "Charge"
  ADD CONSTRAINT "Charge_assessedOnLeaseId_fkey"
  FOREIGN KEY ("assessedOnLeaseId") REFERENCES "Lease"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A fee is anchored to a Charge XOR a Lease, never both - the two paths are
-- mutually exclusive readings of "what is this fee assessed on", and a row
-- carrying both would be an unresolvable ambiguity the application would
-- have to guess its way around. Both null is fine (every non-late-fee
-- charge type leaves both unset).
ALTER TABLE "Charge"
  ADD CONSTRAINT "Charge_assessed_on_charge_xor_lease"
  CHECK ("assessedOnChargeId" IS NULL OR "assessedOnLeaseId" IS NULL);

-- No uniqueness constraint, matching `assessedOnChargeId`'s own lack of one:
-- a nightly assessment can post several delta rows against the same lease
-- over consecutive days, exactly as it already does against the same
-- charge. What is enforced instead is the Stripe invoice item's own
-- idempotency key (per-lease, per-cycle, per-day), same mechanism as the
-- charge-anchored path.
CREATE INDEX "Charge_assessedOnLeaseId_assessedForDueOn_idx"
  ON "Charge" ("assessedOnLeaseId", "assessedForDueOn");
