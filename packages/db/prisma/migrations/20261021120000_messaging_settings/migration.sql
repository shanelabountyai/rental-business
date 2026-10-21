-- R-266 (PRD 08 B5): per-property quiet hours and the deployment's messaging
-- settings (business name for the SMS footer, default reply-Task assignee).

ALTER TABLE "Property" ADD COLUMN "quietHoursStart" INTEGER,
ADD COLUMN "quietHoursEnd" INTEGER;

ALTER TABLE "Property" ADD CONSTRAINT "Property_quietHours_check" CHECK (
    ("quietHoursStart" IS NULL AND "quietHoursEnd" IS NULL)
    OR ("quietHoursStart" BETWEEN 0 AND 23
        AND "quietHoursEnd" BETWEEN 0 AND 23
        AND "quietHoursStart" <> "quietHoursEnd")
);

CREATE TABLE "MessagingSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "businessName" TEXT,
    "replyTaskAssigneeStaffId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessagingSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MessagingSettings_singleton_check" CHECK ("id" = 'default')
);

ALTER TABLE "MessagingSettings" ADD CONSTRAINT "MessagingSettings_replyTaskAssigneeStaffId_fkey" FOREIGN KEY ("replyTaskAssigneeStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
