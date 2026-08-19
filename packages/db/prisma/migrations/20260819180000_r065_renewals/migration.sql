-- LEASE-09 (R-065): renewals.

-- The rent-increase cap, in basis points of the current rent, mirroring
-- lateFeeMaxPercentBps/depositMaxBps's existing bps convention. Null means
-- no statutory cap on file, not "unlimited".
ALTER TABLE "JurisdictionRule" ADD COLUMN "rentIncreaseCapPercentBps" INTEGER;

-- A renewal's successor lease points back at the lease it replaces. Not
-- unique - see the column's own schema comment for why (LeaseEnvelope.leaseId's
-- "voided attempt kept as evidence" precedent, D-52).
ALTER TABLE "Lease" ADD COLUMN "renewedFromLeaseId" TEXT;
ALTER TABLE "Lease" ADD CONSTRAINT "Lease_renewedFromLeaseId_fkey" FOREIGN KEY ("renewedFromLeaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Lease_renewedFromLeaseId_idx" ON "Lease"("renewedFromLeaseId");

-- Nothing in this migration writes a 'RENEWAL' row, so unlike
-- 20260819170100_r064_showing_booking_token this needs no separate
-- migration of its own - the Postgres restriction is on using a new enum
-- value in the SAME transaction that adds it, not on other, unrelated DDL
-- sharing the file.
ALTER TYPE "LeaseOrigin" ADD VALUE 'RENEWAL';
