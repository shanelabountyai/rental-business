-- R-261 (PRD 08 A5): a scheduled announcement. The deliveries carry the
-- schedule (DEFERRED with a per-property `sendAfter`); this row is the index
-- the composer lists and cancels by. Never deleted: cancelling stamps
-- `cancelledAt` and suppresses the deliveries still waiting.

CREATE TABLE "AnnouncementSchedule" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "sendAt" TEXT NOT NULL,
    "lastSendAfter" TIMESTAMP(3) NOT NULL,
    "recipientCount" INTEGER NOT NULL,
    "deliveryIds" TEXT[],
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByStaffId" TEXT,

    CONSTRAINT "AnnouncementSchedule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AnnouncementSchedule_templateId_segment_sendAt_key" ON "AnnouncementSchedule"("templateId", "segment", "sendAt");
CREATE INDEX "AnnouncementSchedule_cancelledAt_lastSendAfter_idx" ON "AnnouncementSchedule"("cancelledAt", "lastSendAfter");

ALTER TABLE "AnnouncementSchedule" ADD CONSTRAINT "AnnouncementSchedule_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AnnouncementSchedule" ADD CONSTRAINT "AnnouncementSchedule_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AnnouncementSchedule" ADD CONSTRAINT "AnnouncementSchedule_cancelledByStaffId_fkey" FOREIGN KEY ("cancelledByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
