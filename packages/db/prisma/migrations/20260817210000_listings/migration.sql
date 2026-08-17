-- R-056 (LEASE-01): listing creation + hosted listing page.

-- Same "not configured" posture R-055's retaliationWindowDays already
-- established for this table - null means unreviewed, never a guessed
-- false or true.
ALTER TABLE "JurisdictionRule" ADD COLUMN "sourceOfIncomeProtected" BOOLEAN;

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'UNPUBLISHED');

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "status" "ListingStatus" NOT NULL DEFAULT 'DRAFT',
    "headline" TEXT,
    "description" TEXT,
    "rentCents" INTEGER NOT NULL,
    "depositCents" INTEGER,
    "availableOn" DATE NOT NULL,
    "requirements" TEXT,
    "petsAllowed" BOOLEAN NOT NULL DEFAULT false,
    "petPolicyText" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdByStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- A listing cannot ask a negative rent or deposit - the same class of typo
-- guard as Lease_nsfFeeCents_nonnegative and every other cents column here.
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_rentCents_nonnegative"
  CHECK ("rentCents" >= 0);
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_depositCents_nonnegative"
  CHECK ("depositCents" IS NULL OR "depositCents" >= 0);

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Listing_propertyId_status_idx" ON "Listing"("propertyId", "status");

-- CreateIndex
CREATE INDEX "Listing_unitId_status_idx" ON "Listing"("unitId", "status");
