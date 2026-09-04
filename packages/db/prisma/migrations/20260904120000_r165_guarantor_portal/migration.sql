-- R-165: a guarantor gets a portal, and a way off the lease that isn't a
-- delete.

-- The guarantor's own auth: same shape as Tenant's `active`/
-- `sessionsValidFrom` pair. Existing rows all default to active, which is
-- correct - nobody has ever been released before this migration.
ALTER TABLE "Guarantor"
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "sessionsValidFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- A guarantor magic link redeems against a different subject type than a
-- tenant's, so it is a separate purpose even though the shape (and TTL) is
-- identical.
ALTER TYPE "AuthTokenPurpose" ADD VALUE 'GUARANTOR_MAGIC_LINK';

-- A guarantor being released is a party moving off the lease, same table as
-- a tenant swap - but it names a Guarantor, not a Tenant, so `tenantId` can
-- no longer be NOT NULL. Every existing row is a tenant move, so a plain
-- ALTER COLUMN is safe: nothing here is null yet.
ALTER TABLE "LeasePartyChangeParty"
  ALTER COLUMN "tenantId" DROP NOT NULL,
  ADD COLUMN "guarantorId" TEXT;

-- Exactly one of tenantId/guarantorId, never both and never neither - this
-- row names ONE person moving.
ALTER TABLE "LeasePartyChangeParty"
  ADD CONSTRAINT "LeasePartyChangeParty_exactly_one_party"
  CHECK (("tenantId" IS NULL) <> ("guarantorId" IS NULL));

-- There is no path here for ADDING a guarantor, only releasing one who is
-- already on the lease - so a guarantorId party is always OUTGOING.
ALTER TABLE "LeasePartyChangeParty"
  ADD CONSTRAINT "LeasePartyChangeParty_guarantor_always_outgoing"
  CHECK ("guarantorId" IS NULL OR "direction" = 'OUTGOING');

CREATE UNIQUE INDEX "LeasePartyChangeParty_changeId_guarantorId_key"
  ON "LeasePartyChangeParty"("changeId", "guarantorId");
CREATE INDEX "LeasePartyChangeParty_guarantorId_idx" ON "LeasePartyChangeParty"("guarantorId");

ALTER TABLE "LeasePartyChangeParty"
  ADD CONSTRAINT "LeasePartyChangeParty_guarantorId_fkey"
  FOREIGN KEY ("guarantorId") REFERENCES "Guarantor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
