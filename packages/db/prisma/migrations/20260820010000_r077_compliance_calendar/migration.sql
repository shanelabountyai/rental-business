-- R-077: compliance calendar (PROP-05).

-- CreateTable
CREATE TABLE "ComplianceItem" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT,
    "legalEntityId" TEXT,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "dueOn" DATE NOT NULL,
    "recurrenceMonths" INTEGER,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 30,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceItem_pkey" PRIMARY KEY ("id")
);

-- Hand-written: exactly one of propertyId/legalEntityId is set. A
-- property-level license and an entity-level annual report are different
-- facts, and Prisma has no way to express an XOR constraint itself.
ALTER TABLE "ComplianceItem" ADD CONSTRAINT "ComplianceItem_scope_check"
  CHECK (("propertyId" IS NOT NULL) != ("legalEntityId" IS NOT NULL));

-- CreateIndex
CREATE INDEX "ComplianceItem_propertyId_idx" ON "ComplianceItem"("propertyId");

-- CreateIndex
CREATE INDEX "ComplianceItem_legalEntityId_idx" ON "ComplianceItem"("legalEntityId");

-- CreateIndex
CREATE INDEX "ComplianceItem_dueOn_idx" ON "ComplianceItem"("dueOn");

-- AddForeignKey
ALTER TABLE "ComplianceItem" ADD CONSTRAINT "ComplianceItem_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceItem" ADD CONSTRAINT "ComplianceItem_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ComplianceCompletion" (
    "id" TEXT NOT NULL,
    "complianceItemId" TEXT NOT NULL,
    "completedOn" DATE NOT NULL,
    "completedByStaffId" TEXT,
    "documentId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComplianceCompletion_complianceItemId_completedOn_idx" ON "ComplianceCompletion"("complianceItemId", "completedOn");

-- AddForeignKey
ALTER TABLE "ComplianceCompletion" ADD CONSTRAINT "ComplianceCompletion_complianceItemId_fkey" FOREIGN KEY ("complianceItemId") REFERENCES "ComplianceItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceCompletion" ADD CONSTRAINT "ComplianceCompletion_completedByStaffId_fkey" FOREIGN KEY ("completedByStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceCompletion" ADD CONSTRAINT "ComplianceCompletion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
