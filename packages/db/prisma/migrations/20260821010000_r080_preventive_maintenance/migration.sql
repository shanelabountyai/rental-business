-- MAINT-08 (R-080): preventive maintenance / seasonal batch templates.
-- One PM-created, free-form template per recurring task (HVAC filters,
-- gutters, winterization, etc.) - the same "nothing hardcoded" posture
-- InspectionTemplate/ComplianceItem already take. WorkOrder gets one new
-- nullable column tagging which template a batch-created job fulfills,
-- the same shape turnoverProjectId already took for R-072.

CREATE TABLE "PreventiveMaintenanceTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trade" TEXT,
    "intervalMonths" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PreventiveMaintenanceTemplate_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PreventiveMaintenanceTemplate" ADD CONSTRAINT "PreventiveMaintenanceTemplate_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WorkOrder" ADD COLUMN "pmTemplateId" TEXT;

CREATE INDEX "WorkOrder_pmTemplateId_idx" ON "WorkOrder"("pmTemplateId");

ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_pmTemplateId_fkey" FOREIGN KEY ("pmTemplateId") REFERENCES "PreventiveMaintenanceTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
