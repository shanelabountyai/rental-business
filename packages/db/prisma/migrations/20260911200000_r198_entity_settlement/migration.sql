-- R-198: the inter-entity sweep is recorded, with the report it was computed from.
--
-- R-180 said what each LLC is owed out of the one shared Stripe balance and
-- bank account, and stopped there: no row anywhere recorded that the money
-- moved, and the report was regenerated on demand. So "on 4 October you moved
-- $6,412 to Maple Holdings LLC, and here is the report it was computed from"
-- could not be produced, and that sentence is what closes a commingling
-- question - not a number that can be recomputed differently next year.
--
-- TWO AMOUNTS. `grossCents` is the report's figure for the window, recomputed
-- when the transfer is recorded; `transferredCents` is what left the account.
-- They differ in the ordinary case by Stripe's fees, which nothing in this
-- product records (R-180).
--
-- APPEND-ONLY, BY TRIGGER, reusing R-002's `reject_mutation()`. A mistyped
-- transfer is corrected on the audit trail and by a real movement, never by an
-- edit that leaves no trace of what it replaced.
--
-- NO BACKFILL (D-201). Sweeps made before this item were never recorded, and
-- a migration cannot know they happened.

CREATE TABLE "EntitySettlement" (
    "id" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "windowFrom" DATE NOT NULL,
    "windowTo" DATE NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "transferredCents" INTEGER NOT NULL,
    "transferredOn" DATE NOT NULL,
    "reference" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntitySettlement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EntitySettlement_window_order" CHECK ("windowFrom" <= "windowTo"),
    -- Nothing owed is nothing to sweep, and moving more than the entity is
    -- owed is not a settlement of this window.
    CONSTRAINT "EntitySettlement_amounts" CHECK (
      "grossCents" > 0 AND "transferredCents" > 0 AND "transferredCents" <= "grossCents"
    ),
    -- Money for a range cannot have been moved before the range's last day.
    CONSTRAINT "EntitySettlement_transferred_after_window" CHECK ("transferredOn" >= "windowTo")
);

CREATE UNIQUE INDEX "EntitySettlement_documentId_key" ON "EntitySettlement"("documentId");

CREATE INDEX "EntitySettlement_legalEntityId_windowFrom_idx" ON "EntitySettlement"("legalEntityId", "windowFrom");

ALTER TABLE "EntitySettlement" ADD CONSTRAINT "EntitySettlement_legalEntityId_fkey"
  FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EntitySettlement" ADD CONSTRAINT "EntitySettlement_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EntitySettlement" ADD CONSTRAINT "EntitySettlement_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER "EntitySettlement_append_only"
  BEFORE UPDATE OR DELETE ON "EntitySettlement"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Row-level triggers do not fire on TRUNCATE.
CREATE TRIGGER "EntitySettlement_no_truncate"
  BEFORE TRUNCATE ON "EntitySettlement"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
