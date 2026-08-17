-- R-057 (LEASE-02, D-7): SimulatedSyndicationAdapter + feed builder, with
-- lead-source attribution and delist-on-lease-up.

-- CreateEnum
CREATE TYPE "SyndicationStatus" AS ENUM ('LISTED', 'DELISTED', 'FAILED');

-- CreateTable
CREATE TABLE "ListingSyndication" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "status" "SyndicationStatus" NOT NULL,
    "externalId" TEXT,
    "lastFaultCode" TEXT,
    "listedAt" TIMESTAMP(3),
    "delistedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListingSyndication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingLead" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingLead_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ListingSyndication" ADD CONSTRAINT "ListingSyndication_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingLead" ADD CONSTRAINT "ListingLead_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "ListingSyndication_listingId_network_key" ON "ListingSyndication"("listingId", "network");

-- CreateIndex
CREATE INDEX "ListingSyndication_listingId_idx" ON "ListingSyndication"("listingId");

-- CreateIndex
CREATE INDEX "ListingLead_listingId_occurredAt_idx" ON "ListingLead"("listingId", "occurredAt");
