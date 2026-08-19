-- CreateEnum
CREATE TYPE "ShowingStatus" AS ENUM ('BOOKED', 'CANCELED');

-- CreateTable
CREATE TABLE "Showing" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "scheduledStart" TIMESTAMP(3) NOT NULL,
    "scheduledEnd" TIMESTAMP(3) NOT NULL,
    "status" "ShowingStatus" NOT NULL DEFAULT 'BOOKED',
    "entryNoticeId" TEXT,
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Showing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Showing_unitId_scheduledStart_idx" ON "Showing"("unitId", "scheduledStart");

-- CreateIndex
CREATE INDEX "Showing_status_scheduledStart_idx" ON "Showing"("status", "scheduledStart");

-- AddForeignKey
ALTER TABLE "Showing" ADD CONSTRAINT "Showing_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Showing" ADD CONSTRAINT "Showing_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Showing" ADD CONSTRAINT "Showing_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Showing" ADD CONSTRAINT "Showing_entryNoticeId_fkey" FOREIGN KEY ("entryNoticeId") REFERENCES "Notice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
