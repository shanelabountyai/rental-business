-- R-025: vendor magic-link dispatch (MAINT-03, D-6, D-16).
--
-- Additive only. Every column is nullable with no default, so existing rows
-- are untouched and no backfill is needed: a work order created before this
-- migration simply has never been dispatched, which is exactly what NULL
-- means here.

ALTER TABLE "WorkOrder" ADD COLUMN "dispatchedAt" TIMESTAMP(3);
ALTER TABLE "WorkOrder" ADD COLUMN "vendorResponse" TEXT;
ALTER TABLE "WorkOrder" ADD COLUMN "vendorRespondedAt" TIMESTAMP(3);
ALTER TABLE "WorkOrder" ADD COLUMN "vendorDeclineReason" TEXT;
ALTER TABLE "WorkOrder" ADD COLUMN "proposedStart" TIMESTAMP(3);
ALTER TABLE "WorkOrder" ADD COLUMN "proposedEnd" TIMESTAMP(3);

-- The no-response sweep (R-025) asks one question every hour: which work
-- orders were dispatched to a vendor who has not answered? Partial, because
-- the answered ones are exactly the rows it never needs to look at, and that
-- is the majority of the table within a day of any dispatch.
CREATE INDEX "WorkOrder_awaiting_vendor_response"
  ON "WorkOrder" ("dispatchedAt")
  WHERE "vendorRespondedAt" IS NULL;
