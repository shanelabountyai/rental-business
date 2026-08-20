-- R-071: deposit disposition (INSP-03).

-- AlterTable
-- Deposit itself is unwritten by anything except R-069's deposit-clearing
-- job (heldCents/receivedAt only) - noticeId is the only genuinely new
-- column here; every other disposition field already existed on the schema
-- from R-041, unused until now.
ALTER TABLE "Deposit" ADD COLUMN     "noticeId" TEXT;

-- CreateTable
CREATE TABLE "DepositDeduction" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "depositId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "workOrderId" TEXT,
    "inspectionItemId" TEXT,
    "estimatedAgeYears" INTEGER,
    "usefulLifeYears" INTEGER,
    "createdByStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositDeduction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DepositDeduction_depositId_idx" ON "DepositDeduction"("depositId");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_noticeId_key" ON "Deposit"("noticeId");

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "depositDeductionId" TEXT;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "Notice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositDeduction" ADD CONSTRAINT "DepositDeduction_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositDeduction" ADD CONSTRAINT "DepositDeduction_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "Deposit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositDeduction" ADD CONSTRAINT "DepositDeduction_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositDeduction" ADD CONSTRAINT "DepositDeduction_inspectionItemId_fkey" FOREIGN KEY ("inspectionItemId") REFERENCES "InspectionItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositDeduction" ADD CONSTRAINT "DepositDeduction_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_depositDeductionId_fkey" FOREIGN KEY ("depositDeductionId") REFERENCES "DepositDeduction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
