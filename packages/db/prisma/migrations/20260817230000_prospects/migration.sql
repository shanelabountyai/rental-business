-- R-058 (LEASE-07): prospect pipeline + identical auto-sent pre-screening
-- questions to every inquiry.

-- AlterEnum
ALTER TYPE "AuthTokenPurpose" ADD VALUE 'PROSPECT_PRESCREEN';

-- AlterEnum
ALTER TYPE "NotificationRecipientType" ADD VALUE 'PROSPECT';

-- CreateEnum
CREATE TYPE "ProspectStatus" AS ENUM ('INQUIRY', 'PRE_SCREENED', 'SHOWING', 'APPLIED', 'SCREENED', 'APPROVED', 'SIGNED');

-- CreateTable
CREATE TABLE "Prospect" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "message" TEXT,
    "source" TEXT NOT NULL,
    "status" "ProspectStatus" NOT NULL DEFAULT 'INQUIRY',
    "moveDate" DATE,
    "occupants" INTEGER,
    "petsDescription" TEXT,
    "incomeRange" TEXT,
    "priorEvictions" BOOLEAN,
    "priorEvictionsDetail" TEXT,
    "preScreenSentAt" TIMESTAMP(3),
    "preScreenRespondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prospect_pkey" PRIMARY KEY ("id")
);

-- A prospect needs SOME way to reach back - both contact fields blank would
-- be an inquiry nobody could ever answer.
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_contact_present"
  CHECK ("email" IS NOT NULL OR "phone" IS NOT NULL);

-- AddForeignKey
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Prospect_propertyId_status_idx" ON "Prospect"("propertyId", "status");

-- CreateIndex
CREATE INDEX "Prospect_listingId_idx" ON "Prospect"("listingId");
