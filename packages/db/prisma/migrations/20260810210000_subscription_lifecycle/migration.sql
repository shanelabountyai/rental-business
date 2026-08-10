-- R-036: subscription lifecycle (D-11, PAY-03).
--
-- `collectionPaused` is deliberately separate from `active`. A paused payer
-- still owes the money and is still the payer; we are simply not collecting.
-- PAY-12 is explicit that in many states accepting a payment after serving
-- notice voids the notice, so "stop collecting but keep the debt" is a real
-- state the schema has to be able to express.
--
-- The lastSync* columns are operational breadcrumbs for the Billing Runs
-- screen, NOT a second source of truth about the subscription. Under D-11
-- that is Stripe's, and the re-sync action asks Stripe rather than trusting
-- these.

ALTER TABLE "LeasePayer" ADD COLUMN "collectionPaused" BOOLEAN NOT NULL DEFAULT false;
-- What we last TOLD Stripe the rent was. Not a copy of Stripe's truth - a
-- record of our last instruction, which is what makes "we have not pushed
-- this rent change yet" answerable without an API call.
ALTER TABLE "LeasePayer" ADD COLUMN "stripeAmountCents" INTEGER;
ALTER TABLE "LeasePayer" ADD COLUMN "lastSyncedAt" TIMESTAMP(3);
ALTER TABLE "LeasePayer" ADD COLUMN "lastSyncAction" TEXT;
ALTER TABLE "LeasePayer" ADD COLUMN "lastSyncError" TEXT;

-- The Billing Runs screen's own query: payers whose last sync failed, or
-- that have never been synced at all. Partial, because a healthy payer is
-- exactly the row it never needs to look at.
CREATE INDEX "LeasePayer_needs_attention"
  ON "LeasePayer" ("propertyId")
  WHERE "lastSyncError" IS NOT NULL OR "lastSyncedAt" IS NULL;
