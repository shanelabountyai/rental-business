-- R-033: lease records (LEASE-06, RISK-08).
--
-- The Lease table itself has existed since R-002's core data model. What is
-- new here is everything the INHERITED path needs: where a tenancy came
-- from, whether the deposit money actually reached us, and whether the
-- tenant has confirmed that the terms we transcribed from the seller's
-- paperwork are the terms they actually have.

CREATE TYPE "NoticeParty" AS ENUM ('TENANT', 'LANDLORD');
CREATE TYPE "LeaseOrigin" AS ENUM ('APPLICATION', 'INHERITED');
CREATE TYPE "DepositTransferStatus" AS ENUM (
  'NOT_APPLICABLE',
  'UNKNOWN',
  'TRANSFERRED',
  'NOT_TRANSFERRED'
);

ALTER TABLE "Lease" ADD COLUMN "noticeGivenBy" "NoticeParty";
ALTER TABLE "Lease" ADD COLUMN "origin" "LeaseOrigin" NOT NULL DEFAULT 'APPLICATION';
ALTER TABLE "Lease" ADD COLUMN "depositTransferStatus" "DepositTransferStatus" NOT NULL DEFAULT 'NOT_APPLICABLE';
ALTER TABLE "Lease" ADD COLUMN "depositTransferNote" TEXT;
ALTER TABLE "Lease" ADD COLUMN "estoppelConfirmedAt" TIMESTAMP(3);
ALTER TABLE "Lease" ADD COLUMN "activatedAt" TIMESTAMP(3);

-- The acquisition worklist: inherited tenancies whose deposit status is
-- still unestablished. Partial, because every other lease is a row this
-- query never needs to look at - and the whole point of the index is that
-- the list should be short and shrinking.
CREATE INDEX "Lease_inherited_unresolved_deposit"
  ON "Lease" ("propertyId")
  WHERE "origin" = 'INHERITED' AND "depositTransferStatus" = 'UNKNOWN';
