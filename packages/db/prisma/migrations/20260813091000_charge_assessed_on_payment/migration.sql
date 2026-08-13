-- R-039a: what a returned-payment fee was assessed on (PAY-02; D-11).
--
-- Split into its own migration rather than appended to the one before it:
-- 20260813090000 had already been applied, and Prisma records an applied
-- migration by checksum - editing the file leaves the new SQL unrun while
-- `migrate deploy` reports nothing pending. Caught because the column existed
-- in schema.prisma and not in the database.

-- WHAT THE FEE WAS ASSESSED ON, when the trigger was a payment rather than a
-- charge. `assessedOnChargeId` already carries this for a late fee ("this
-- rent charge went unpaid"); a returned-payment fee answers to a Payment
-- instead ("this debit came back").
--
-- It is also the idempotency key. Stripe redelivers webhooks and promises
-- neither ordering nor exactly-once, and a tenant charged twice for one
-- bounced payment is a support call that starts from a position of being
-- wrong - so the partial unique index below is what actually prevents it,
-- rather than a read-then-write check that two concurrent deliveries would
-- both pass.
ALTER TABLE "Charge" ADD COLUMN "assessedOnPaymentId" TEXT;

-- RESTRICT, like every other foreign key in this schema that points at a row
-- the evidence trail depends on. A payment that a fee was assessed on cannot
-- be deleted out from under the fee.
ALTER TABLE "Charge"
  ADD CONSTRAINT "Charge_assessedOnPaymentId_fkey"
  FOREIGN KEY ("assessedOnPaymentId") REFERENCES "Payment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- One NSF fee per returned payment, enforced by the database rather than by
-- application code. Partial, because every other charge type leaves this
-- column null and a plain unique index would allow exactly one of them.
CREATE UNIQUE INDEX "Charge_one_nsf_fee_per_payment"
  ON "Charge" ("assessedOnPaymentId")
  WHERE "assessedOnPaymentId" IS NOT NULL;
