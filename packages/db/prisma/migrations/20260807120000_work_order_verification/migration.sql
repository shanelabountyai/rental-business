-- R-030: verify & close (MAINT-07).
--
-- Additive. The money columns (actualLaborCents, actualMaterialsCents,
-- invoiceCents) already exist from R-026 - this item is what finally reads
-- them, which is why there is no new money column here. The chain the PRD
-- asks for is work order -> invoice -> books with no re-keying, and a second
-- place to type the same number would be exactly the re-keying it forbids.

ALTER TABLE "WorkOrder" ADD COLUMN "reopenedAt" TIMESTAMP(3);
ALTER TABLE "WorkOrder" ADD COLUMN "reopenCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkOrder" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "WorkOrder" ADD COLUMN "closedByStaffId" TEXT;
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_closedByStaffId_fkey"
  FOREIGN KEY ("closedByStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "WorkOrderVerification" (
  "id"          TEXT NOT NULL,
  "workOrderId" TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "vendorId"    TEXT,
  "round"       INTEGER NOT NULL DEFAULT 1,
  "resolved"    BOOLEAN NOT NULL,
  "rating"      INTEGER,
  "comment"     TEXT,
  "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkOrderVerification_pkey" PRIMARY KEY ("id")
);

-- One answer per round. A tenant tapping twice is one answer, not two - and
-- this is the constraint that makes it true under a double-tap rather than
-- a check-then-insert that races.
CREATE UNIQUE INDEX "WorkOrderVerification_workOrderId_round_key"
  ON "WorkOrderVerification"("workOrderId", "round");

-- The reopen-rate report's own query: every answer attributed to a vendor,
-- split by whether it came back.
CREATE INDEX "WorkOrderVerification_vendorId_resolved_idx"
  ON "WorkOrderVerification"("vendorId", "resolved");

ALTER TABLE "WorkOrderVerification" ADD CONSTRAINT "WorkOrderVerification_workOrderId_fkey"
  FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkOrderVerification" ADD CONSTRAINT "WorkOrderVerification_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkOrderVerification" ADD CONSTRAINT "WorkOrderVerification_vendorId_fkey"
  FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
