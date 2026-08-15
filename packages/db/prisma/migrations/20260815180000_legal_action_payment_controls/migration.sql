-- R-047 (PAY-12): per-tenant payment controls for a tenancy in legal action.
--
-- In many states ACCEPTING A PARTIAL PAYMENT AFTER SERVING NOTICE VOIDS THE
-- NOTICE. These are therefore not preferences about how somebody likes to be
-- paid; they are a control on money the owner must not receive, and a payment
-- that slips through restarts a legal process.
--
-- `collectionPaused` (added by 20260810210000) IS the block-online switch: it
-- already pauses the Stripe subscription AND is already refused by the
-- payment UI, which is the "both halves" the backlog insists on. These two
-- columns are the postures it did not cover.
--
-- DELIBERATELY NOT REUSING `Lease.requireFullBalance`, which looks like the
-- same thing as blockPartialPayments and is not: that is an owner's ordinary
-- commercial preference about a payer they will not take part payments from,
-- typically after a payment plan already failed, and it is left on
-- indefinitely. Lifting a legal hold must not silently clear it, and a
-- shared column could not tell the two reasons apart.
ALTER TABLE "LeasePayer" ADD COLUMN "blockPartialPayments" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LeasePayer" ADD COLUMN "certifiedFundsOnly" BOOLEAN NOT NULL DEFAULT false;

-- Why, who and when. Required by the application whenever any switch is on:
-- "we stopped taking this tenant's money" is the fact an eviction is later
-- argued from, and a hold nobody can explain is worse than no hold. Nullable
-- in the database because a payer with no hold has none of them.
ALTER TABLE "LeasePayer" ADD COLUMN "paymentHoldReason" TEXT;
ALTER TABLE "LeasePayer" ADD COLUMN "paymentHoldSetAt" TIMESTAMP(3);
ALTER TABLE "LeasePayer" ADD COLUMN "paymentHoldSetByStaffId" TEXT;

-- RESTRICT, like every other foreign key here pointing at a row the evidence
-- trail depends on: who placed a payment hold is part of explaining an
-- eviction it contributed to.
ALTER TABLE "LeasePayer"
  ADD CONSTRAINT "LeasePayer_paymentHoldSetByStaffId_fkey"
  FOREIGN KEY ("paymentHoldSetByStaffId") REFERENCES "StaffUser"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
