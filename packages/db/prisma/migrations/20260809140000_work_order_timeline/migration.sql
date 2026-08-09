-- R-032: work-order comms threading (COMM-06).
--
-- Message gains ticketId/workOrderId so a message living in a tenant's
-- CONTINUOUS thread (COMM-01) can still be tagged as evidence of one
-- specific incident. WorkOrderNote is new: staff-only, never sent to
-- anyone, and deliberately not shoehorned into Message's shape.

ALTER TABLE "Message" ADD COLUMN "ticketId" TEXT;
ALTER TABLE "Message" ADD COLUMN "workOrderId" TEXT;
-- RESTRICT, not SET NULL. Message is append-only (Message_append_only,
-- migration 20260801152520) - its trigger rejects every UPDATE as well as
-- every DELETE, which means a SET NULL cascade could never actually run: a
-- deleted Ticket or WorkOrder would hit the trigger's exception instead of
-- cleanly clearing the reference. RESTRICT says the true thing - a Ticket
-- or WorkOrder with tagged messages cannot be deleted at all - and neither
-- ever is in this product (both move through status transitions, never
-- deletion), so the constraint is never expected to bind in practice.
ALTER TABLE "Message" ADD CONSTRAINT "Message_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_workOrderId_fkey"
  FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Message_ticketId_idx" ON "Message"("ticketId");
CREATE INDEX "Message_workOrderId_idx" ON "Message"("workOrderId");

CREATE TABLE "WorkOrderNote" (
  "id"          TEXT NOT NULL,
  "workOrderId" TEXT NOT NULL,
  "staffUserId" TEXT NOT NULL,
  "body"        TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkOrderNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkOrderNote_workOrderId_createdAt_idx"
  ON "WorkOrderNote"("workOrderId", "createdAt");
ALTER TABLE "WorkOrderNote" ADD CONSTRAINT "WorkOrderNote_workOrderId_fkey"
  FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkOrderNote" ADD CONSTRAINT "WorkOrderNote_staffUserId_fkey"
  FOREIGN KEY ("staffUserId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
