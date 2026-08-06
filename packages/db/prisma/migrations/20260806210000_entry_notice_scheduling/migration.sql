-- R-027: scheduling with entry-notice compliance (MAINT-05, COMM-02).
--
-- Additive only, every column nullable. An existing work order has simply
-- never been scheduled, which is what NULL already means here.

ALTER TABLE "WorkOrder" ADD COLUMN "entryNoticeId" TEXT;
ALTER TABLE "WorkOrder" ADD COLUMN "entryPermissionGrantedAt" TIMESTAMP(3);
ALTER TABLE "WorkOrder" ADD COLUMN "entryPermissionLoggedByStaffId" TEXT;
ALTER TABLE "WorkOrder" ADD COLUMN "entryOverrideReason" TEXT;
ALTER TABLE "WorkOrder" ADD COLUMN "entryOverriddenAt" TIMESTAMP(3);
ALTER TABLE "WorkOrder" ADD COLUMN "tenantNoShowAt" TIMESTAMP(3);

ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_entryNoticeId_fkey"
  FOREIGN KEY ("entryNoticeId") REFERENCES "Notice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_entryPermissionLoggedByStaffId_fkey"
  FOREIGN KEY ("entryPermissionLoggedByStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The T-1-day reminder sweep asks one question hourly: which scheduled
-- visits start tomorrow and have not been reminded? Partial, because a work
-- order with no scheduled window is never the answer.
CREATE INDEX "WorkOrder_scheduled_upcoming"
  ON "WorkOrder" ("scheduledStart")
  WHERE "scheduledStart" IS NOT NULL;
