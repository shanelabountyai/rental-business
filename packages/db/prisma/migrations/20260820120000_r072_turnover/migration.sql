-- LEASE-12, INSP-06 (R-072): turnover / make-ready as a project.
-- The checklist itself is not a new table - each stage is an ordinary
-- WorkOrder (see the two new nullable columns below); this migration adds
-- the project envelope and the vocabulary for which stage a work order is.

CREATE TYPE "TurnoverStage" AS ENUM ('TRASH_OUT', 'REPAIRS', 'PAINT', 'FLOORS', 'CLEAN', 'REKEY', 'OTHER');

CREATE TABLE "TurnoverProject" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "targetRentReadyDate" DATE,
    "rentReadyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TurnoverProject_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TurnoverProject_leaseId_key" ON "TurnoverProject"("leaseId");
CREATE INDEX "TurnoverProject_propertyId_idx" ON "TurnoverProject"("propertyId");
CREATE INDEX "TurnoverProject_unitId_rentReadyAt_idx" ON "TurnoverProject"("unitId", "rentReadyAt");

ALTER TABLE "TurnoverProject" ADD CONSTRAINT "TurnoverProject_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TurnoverProject" ADD CONSTRAINT "TurnoverProject_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TurnoverProject" ADD CONSTRAINT "TurnoverProject_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WorkOrder" ADD COLUMN "turnoverProjectId" TEXT;
ALTER TABLE "WorkOrder" ADD COLUMN "turnoverStage" "TurnoverStage";

CREATE INDEX "WorkOrder_turnoverProjectId_idx" ON "WorkOrder"("turnoverProjectId");

ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_turnoverProjectId_fkey" FOREIGN KEY ("turnoverProjectId") REFERENCES "TurnoverProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
