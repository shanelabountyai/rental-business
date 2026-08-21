-- R-078 (PROP-07, RPT-03): the capital-improvement log.
--
-- A repair is deducted in the year it is paid; an improvement is capitalised
-- and depreciated from the day it is placed in service. This table is the
-- record that tells the tax export which of the two a piece of spend was.

CREATE TABLE "CapitalImprovement" (
  "id"                TEXT NOT NULL,
  "propertyId"        TEXT NOT NULL,
  "category"          TEXT NOT NULL,
  "description"       TEXT NOT NULL,
  "costCents"         INTEGER NOT NULL,
  "inServiceOn"       DATE,
  "workOrderId"       TEXT,
  "recordedByStaffId" TEXT NOT NULL,
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CapitalImprovement_pkey" PRIMARY KEY ("id")
);

-- One improvement per work order. Load-bearing rather than tidiness: the tax
-- export excludes exactly the work orders named here from deductible repairs,
-- and two rows pointing at one job would make that exclusion ambiguous.
CREATE UNIQUE INDEX "CapitalImprovement_workOrderId_key"
  ON "CapitalImprovement"("workOrderId");

CREATE INDEX "CapitalImprovement_propertyId_inServiceOn_idx"
  ON "CapitalImprovement"("propertyId", "inServiceOn");

ALTER TABLE "CapitalImprovement"
  ADD CONSTRAINT "CapitalImprovement_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CapitalImprovement"
  ADD CONSTRAINT "CapitalImprovement_workOrderId_fkey"
  FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CapitalImprovement"
  ADD CONSTRAINT "CapitalImprovement_recordedByStaffId_fkey"
  FOREIGN KEY ("recordedByStaffId") REFERENCES "StaffUser"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The warranty paperwork and the invoice behind the improvement.
ALTER TABLE "Document" ADD COLUMN "capitalImprovementId" TEXT;

CREATE INDEX "Document_capitalImprovementId_idx"
  ON "Document"("capitalImprovementId");

ALTER TABLE "Document"
  ADD CONSTRAINT "Document_capitalImprovementId_fkey"
  FOREIGN KEY ("capitalImprovementId") REFERENCES "CapitalImprovement"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
