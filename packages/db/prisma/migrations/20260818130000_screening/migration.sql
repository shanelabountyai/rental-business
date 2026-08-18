-- R-060 (LEASE-04): SimulatedScreeningAdapter + written screening criteria
-- as versioned config. No SSN-shaped column exists on either new table -
-- see the schema file's own header.

-- CreateTable
CREATE TABLE "ScreeningCriteria" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "incomeToRentMultiplierX100" INTEGER NOT NULL,
    "minCreditScore" INTEGER,
    "evictionLookbackMonths" INTEGER NOT NULL,
    "criminalLookbackMonths" INTEGER NOT NULL,
    "citation" TEXT,
    "reviewedBy" TEXT,
    "notes" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdByStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScreeningCriteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScreeningReport" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "faultCode" TEXT,
    "creditScore" INTEGER,
    "evictionRecordFound" BOOLEAN,
    "criminalRecordFound" BOOLEAN,
    "criteriaVersion" INTEGER NOT NULL,
    "decision" TEXT,
    "decisionNotes" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedByStaffId" TEXT,
    "orderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ScreeningReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningCriteria_version_key" ON "ScreeningCriteria"("version");

-- CreateIndex
CREATE INDEX "ScreeningCriteria_effectiveTo_idx" ON "ScreeningCriteria"("effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningReport_applicantId_key" ON "ScreeningReport"("applicantId");

-- CreateIndex
CREATE INDEX "ScreeningReport_applicantId_idx" ON "ScreeningReport"("applicantId");

-- AddForeignKey
ALTER TABLE "ScreeningCriteria" ADD CONSTRAINT "ScreeningCriteria_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningReport" ADD CONSTRAINT "ScreeningReport_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningReport" ADD CONSTRAINT "ScreeningReport_decidedByStaffId_fkey" FOREIGN KEY ("decidedByStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
