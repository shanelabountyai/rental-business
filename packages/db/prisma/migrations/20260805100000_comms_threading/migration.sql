-- Comms threading core (COMM-01, R-017).
--
-- Thread.key is added NOT NULL with no default, which is only safe because
-- Thread is empty: R-002 modelled it and nothing has created a row since -
-- R-017 is its first writer. Verified before generating this migration, not
-- assumed. A later migration adding a required column to a populated table
-- needs a backfill step this one legitimately does not.

-- DropIndex
DROP INDEX "Thread_propertyId_idx";

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "key" TEXT NOT NULL,
ADD COLUMN     "lastMessageAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "UnroutedMessage" (
    "id" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "direction" "MessageDirection" NOT NULL DEFAULT 'INBOUND',
    "fromAddress" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "externalId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "routedMessageId" TEXT,
    "routedAt" TIMESTAMP(3),
    "routedByStaffId" TEXT,

    CONSTRAINT "UnroutedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UnroutedMessage_externalId_key" ON "UnroutedMessage"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "UnroutedMessage_routedMessageId_key" ON "UnroutedMessage"("routedMessageId");

-- CreateIndex
CREATE INDEX "UnroutedMessage_routedAt_receivedAt_idx" ON "UnroutedMessage"("routedAt", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_key_key" ON "Thread"("key");

-- CreateIndex
CREATE INDEX "Thread_propertyId_lastMessageAt_idx" ON "Thread"("propertyId", "lastMessageAt");

-- AddForeignKey
ALTER TABLE "UnroutedMessage" ADD CONSTRAINT "UnroutedMessage_routedMessageId_fkey" FOREIGN KEY ("routedMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnroutedMessage" ADD CONSTRAINT "UnroutedMessage_routedByStaffId_fkey" FOREIGN KEY ("routedByStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

