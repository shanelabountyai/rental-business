-- R-032 follow-up: attaching an EXISTING message to a work order cannot be
-- an update to Message (Message_append_only rejects every UPDATE, not only
-- DELETE - see migration 20260801152520). A separate insert-only link table
-- records the same fact without ever touching the original row.

CREATE TABLE "WorkOrderMessageLink" (
  "id"              TEXT NOT NULL,
  "workOrderId"     TEXT NOT NULL,
  "messageId"       TEXT NOT NULL,
  "linkedByStaffId" TEXT NOT NULL,
  "linkedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkOrderMessageLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkOrderMessageLink_messageId_key" ON "WorkOrderMessageLink"("messageId");
CREATE INDEX "WorkOrderMessageLink_workOrderId_idx" ON "WorkOrderMessageLink"("workOrderId");

ALTER TABLE "WorkOrderMessageLink" ADD CONSTRAINT "WorkOrderMessageLink_workOrderId_fkey"
  FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkOrderMessageLink" ADD CONSTRAINT "WorkOrderMessageLink_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkOrderMessageLink" ADD CONSTRAINT "WorkOrderMessageLink_linkedByStaffId_fkey"
  FOREIGN KEY ("linkedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
