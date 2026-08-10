-- R-034: Stripe Billing foundation (D-11).
--
-- The money columns this item fills in (LeasePayer.stripeCustomerId /
-- stripeSubscriptionId, Payment.stripe*, LedgerEntry.stripe*) have existed
-- since R-002's core data model, which anticipated this item by name. What
-- is new is the idempotency log: Stripe retries webhooks until it gets a
-- 2xx and does not promise exactly-once delivery, so without this a retried
-- payment event would credit a tenant twice in a ledger nobody can edit.

CREATE TABLE "ProcessedStripeEvent" (
  -- The event id IS the primary key: the insert is the lock. Two concurrent
  -- deliveries both try to claim it, one loses, and the loser stops. A
  -- check-then-write would let both through.
  "stripeEventId" TEXT NOT NULL,
  "type"          TEXT NOT NULL,
  "outcome"       TEXT NOT NULL,
  "detail"        TEXT,
  "occurredAt"    TIMESTAMP(3) NOT NULL,
  "processedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProcessedStripeEvent_pkey" PRIMARY KEY ("stripeEventId")
);

CREATE INDEX "ProcessedStripeEvent_occurredAt_idx" ON "ProcessedStripeEvent"("occurredAt");
CREATE INDEX "ProcessedStripeEvent_type_idx" ON "ProcessedStripeEvent"("type");

-- ---------------------------------------------------------------------------
-- LedgerEntry's own foreign keys: SET NULL -> RESTRICT.
--
-- A latent misdeclaration since R-002, found by R-034's first test that
-- actually wrote ledger rows and then tried to clean up after itself. Every
-- one of these was ON DELETE SET NULL onto a table whose trigger
-- (LedgerEntry_append_only, migration 20260801152520) rejects every UPDATE -
-- so the cascade could never run. Deleting the referenced Payment, Charge,
-- LeasePayer or reversed entry did not clear the reference; it raised
-- "LedgerEntry is append-only" and failed the whole statement.
--
-- RESTRICT states the truth: a row the ledger points at cannot be deleted.
-- That is the intended behaviour under D-11 - the projection is evidence and
-- outlives the things it refers to - and it now fails with a message naming
-- the real reason instead of one about append-only triggers.
--
-- The identical fix R-032 applied to Message.ticketId / workOrderId, for the
-- identical reason.

ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_leasePayerId_fkey";
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_leasePayerId_fkey"
  FOREIGN KEY ("leasePayerId") REFERENCES "LeasePayer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_chargeId_fkey";
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_chargeId_fkey"
  FOREIGN KEY ("chargeId") REFERENCES "Charge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_paymentId_fkey";
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_reversesId_fkey";
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_reversesId_fkey"
  FOREIGN KEY ("reversesId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
