-- R-094b (PROP-03, LEASE-08): the smart-lock code lifecycle tied to lease
-- state.
--
-- ==========================================================================
-- ONE CODE PER PERSON, NOT PER TENANCY, and that single choice is most of
-- the item. A shared household code is what a mechanical lockbox forces and
-- it makes both of the things this feature exists for impossible: the entry
-- log cannot say who came in, and a roommate leaving cannot be taken off the
-- door without changing the code for everybody who is staying. Per person,
-- both work, and R-090's party change becomes one revoke rather than a
-- re-key.
--
-- ISSUING IS DELIBERATE, REVOKING IS AUTOMATIC, and the asymmetry is the
-- design. R-069 gates handing a code to a tenant on move-in funds actually
-- clearing (INSP-01) and on no hold halting access changes (R-084), and none
-- of that becomes less true because the lock is electronic - so a code is
-- minted only when somebody with `accesscode.issue` decides to. Revocation
-- has no gate at all and needs none: it happens on its own when the tenancy
-- leaves force and when a party comes off the lease, because the failure
-- mode of a missed revoke is a former occupant who can still walk in.
--
-- `validTo` IS NULL FOR A TENANT, deliberately, where a showing's is the
-- whole control. An expiring tenant code is a paying tenant locked out of
-- their own home at midnight because a fixed term rolled to month-to-month
-- and nobody noticed. The end of a tenancy is an event this system already
-- knows about and acts on; it is not a clock to be set in advance.
--
-- `revokeReachedDevice` carries R-094's lesson forward: the row saying
-- "revoked" and the door agreeing are two different facts, and the second
-- one is the one somebody has to act on.
-- ==========================================================================

CREATE TABLE "TenantLockCode" (
  "id"          TEXT NOT NULL,
  "smartLockId" TEXT NOT NULL,
  "leaseId"     TEXT NOT NULL,
  "tenantId"    TEXT NOT NULL,
  "providerRef" TEXT NOT NULL,
  -- Sealed by the same box `AccessCode.sealedCode` and
  -- `ShowingAccess.sealedCode` use (R-005). Shown to the tenant once, at
  -- issue, by the same act R-069 already audits as `accesscode.issued`.
  "sealedCode"  TEXT NOT NULL,

  "issuedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "issuedByStaffId" TEXT NOT NULL,

  "revokedAt"           TIMESTAMP(3),
  "revokedReason"       TEXT,
  -- Null where the revoke was automatic - a tenancy ending or a party coming
  -- off the lease has no person to attribute, and inventing one would be a
  -- worse record than an honest absence.
  "revokedByStaffId"    TEXT,
  "revokeReachedDevice" BOOLEAN,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TenantLockCode_pkey" PRIMARY KEY ("id"),
  -- A revoke with no stated reason is indistinguishable from a mis-click,
  -- and here it is worse than on a showing: this one takes somebody out of
  -- the home they live in.
  CONSTRAINT "TenantLockCode_revoked_with_reason"
    CHECK (("revokedAt" IS NULL) = ("revokedReason" IS NULL)),
  -- One-directional, for the reason R-094's own column records: whether the
  -- device heard is unknown for any row predating this, and inventing an
  -- answer about a physical lock is worse than an honest null.
  CONSTRAINT "TenantLockCode_revoke_outcome_is_coherent"
    CHECK ("revokeReachedDevice" IS NULL OR "revokedAt" IS NOT NULL)
);

-- AT MOST ONE LIVE CODE PER PERSON PER TENANCY, and it is a partial unique
-- index because that is the only shape that expresses it - a plain unique
-- would forbid the history this table exists to keep. Prisma cannot express
-- a partial index, so it is NOT in schema.prisma and would report drift if
-- it were; CLAUDE.md records the `SmsOptOut` one that did. The application
-- checks it too, because a 23505 is a 500 rather than a sentence.
CREATE UNIQUE INDEX "TenantLockCode_one_live_per_tenant"
  ON "TenantLockCode"("leaseId", "tenantId")
  WHERE "revokedAt" IS NULL;

CREATE INDEX "TenantLockCode_leaseId_idx" ON "TenantLockCode"("leaseId");
CREATE INDEX "TenantLockCode_smartLockId_idx" ON "TenantLockCode"("smartLockId");
CREATE INDEX "TenantLockCode_tenantId_idx" ON "TenantLockCode"("tenantId");

ALTER TABLE "TenantLockCode"
  ADD CONSTRAINT "TenantLockCode_smartLockId_fkey"
  FOREIGN KEY ("smartLockId") REFERENCES "SmartLock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantLockCode"
  ADD CONSTRAINT "TenantLockCode_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantLockCode"
  ADD CONSTRAINT "TenantLockCode_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantLockCode"
  ADD CONSTRAINT "TenantLockCode_issuedByStaffId_fkey"
  FOREIGN KEY ("issuedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantLockCode"
  ADD CONSTRAINT "TenantLockCode_revokedByStaffId_fkey"
  FOREIGN KEY ("revokedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- R-094 gave `LockEvent.showingAccessId` a null for "no code of ours
-- explains this". A tenant's code is now a second thing that can explain
-- one, and leaving it out would make every tenant entry read as unexplained
-- - which is exactly the signal the null exists to carry.
ALTER TABLE "LockEvent" ADD COLUMN "tenantLockCodeId" TEXT;
ALTER TABLE "LockEvent"
  ADD CONSTRAINT "LockEvent_tenantLockCodeId_fkey"
  FOREIGN KEY ("tenantLockCodeId") REFERENCES "TenantLockCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
