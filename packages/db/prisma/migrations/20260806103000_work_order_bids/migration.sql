-- R-026: bid collection (MAINT-04's fourth criterion).

ALTER TYPE "AuthTokenPurpose" ADD VALUE 'VENDOR_BID';

CREATE TABLE "WorkOrderBid" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "amountCents" INTEGER,
    "note" TEXT,
    "declinedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkOrderBid_pkey" PRIMARY KEY ("id")
);

-- Asking the same vendor twice is re-asking, not a second opinion.
CREATE UNIQUE INDEX "WorkOrderBid_workOrderId_vendorId_key"
  ON "WorkOrderBid"("workOrderId", "vendorId");
CREATE INDEX "WorkOrderBid_workOrderId_idx" ON "WorkOrderBid"("workOrderId");

ALTER TABLE "WorkOrderBid" ADD CONSTRAINT "WorkOrderBid_workOrderId_fkey"
  FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkOrderBid" ADD CONSTRAINT "WorkOrderBid_vendorId_fkey"
  FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
