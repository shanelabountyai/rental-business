-- CreateEnum
CREATE TYPE "NotificationRecipientType" AS ENUM ('STAFF', 'TENANT', 'GUARANTOR', 'VENDOR');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DeliveryStatus" ADD VALUE 'SUPPRESSED';
ALTER TYPE "DeliveryStatus" ADD VALUE 'DEFERRED';

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "recipientType" "NotificationRecipientType" NOT NULL,
    "recipientId" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "propertyId" TEXT,
    "eventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "suppressedReason" TEXT,
    "sendAfter" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "externalId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "recipientType" "NotificationRecipientType" NOT NULL,
    "recipientId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_idempotencyKey_key" ON "Notification"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Notification_recipientType_recipientId_createdAt_idx" ON "Notification"("recipientType", "recipientId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_propertyId_createdAt_idx" ON "Notification"("propertyId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_category_createdAt_idx" ON "Notification"("category", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_notificationId_key" ON "NotificationDelivery"("notificationId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_sendAfter_idx" ON "NotificationDelivery"("status", "sendAfter");

-- CreateIndex
CREATE INDEX "NotificationDelivery_externalId_idx" ON "NotificationDelivery"("externalId");

-- CreateIndex
CREATE INDEX "NotificationPreference_recipientType_recipientId_idx" ON "NotificationPreference"("recipientType", "recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_recipientType_recipientId_category_c_key" ON "NotificationPreference"("recipientType", "recipientId", "category", "channel");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "OutboxEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Notification joins LedgerEntry, AuditLog and Message as append-only
-- (R-016, NOTIF-01: "all attempts/failures/retries logged centrally").
--
-- A decided send is evidence. "We texted this tenant the late notice on the
-- 3rd, to this number, with this wording" is exactly what a deposit or
-- eviction dispute turns on, and a log that can be edited afterwards is worth
-- nothing in one. Corrections are new rows.
--
-- NotificationDelivery is deliberately NOT protected: it exists precisely so
-- provider callbacks can move QUEUED -> SENT -> DELIVERED without touching
-- the immutable half. Same split, same reasoning, as Message/MessageDelivery.
--
-- Consequence, already true of AuditLog and worked around the same way in
-- every e2e spec: Notification.propertyId is ON DELETE SET NULL, and SET NULL
-- is an UPDATE, so a property with notifications cannot be hard-deleted.
-- Deactivate it instead.
-- ---------------------------------------------------------------------------

CREATE TRIGGER "Notification_append_only"
  BEFORE UPDATE OR DELETE ON "Notification"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "Notification_no_truncate"
  BEFORE TRUNCATE ON "Notification"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
