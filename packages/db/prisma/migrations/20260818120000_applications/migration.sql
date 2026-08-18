-- R-059 (LEASE-03): online application, one per adult 18+, co-applicant
-- grouping and links, save-and-resume, document upload, application fee
-- payment with jurisdiction fee caps, completion timestamp.

-- AlterEnum
ALTER TYPE "AuthTokenPurpose" ADD VALUE 'APPLICATION_LINK';

-- AlterEnum
ALTER TYPE "NotificationRecipientType" ADD VALUE 'APPLICANT';

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN "applicationFeeCents" INTEGER;

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Applicant" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "isLead" BOOLEAN NOT NULL DEFAULT false,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "dateOfBirth" DATE,
    "currentAddressLine1" TEXT,
    "currentCity" TEXT,
    "currentState" TEXT,
    "currentPostalCode" TEXT,
    "monthsAtCurrentAddress" INTEGER,
    "employerName" TEXT,
    "monthlyIncomeCents" INTEGER,
    "feeCents" INTEGER,
    "stripeCustomerId" TEXT,
    "stripePaymentIntentId" TEXT,
    "feePaidAt" TIMESTAMP(3),
    "formSubmittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Applicant_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "applicantId" TEXT;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Applicant" ADD CONSTRAINT "Applicant_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Application_propertyId_idx" ON "Application"("propertyId");

-- CreateIndex
CREATE INDEX "Application_listingId_idx" ON "Application"("listingId");

-- CreateIndex
CREATE INDEX "Application_prospectId_idx" ON "Application"("prospectId");

-- CreateIndex
CREATE INDEX "Applicant_applicationId_idx" ON "Applicant"("applicationId");

-- CreateIndex
CREATE INDEX "Applicant_stripeCustomerId_idx" ON "Applicant"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "Document_applicantId_idx" ON "Document"("applicantId");
