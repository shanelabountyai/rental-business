-- R-090 (RISK-10): roommate changes and lease assignment.
--
-- THE SAME LEASE ROW IS THE WHOLE ITEM. A renewal creates a successor Lease
-- (`Lease.renewedFromLeaseId`); a change of who is on a tenancy must not,
-- and every hard part of RISK-10 falls out of that one decision:
--
--   "ledger continuity"  - nothing to build. No lease ended, so no balance
--                          moved, no Stripe subscription was cancelled and
--                          no new one was provisioned.
--   "the deposit stays   - nothing to build. A deposit disposition is
--    with the unit"        triggered by a tenancy ENDING (see
--                          lib/leases/deposit-disposition-start.ts). No
--                          tenancy ended, so there was never a moment at
--                          which anything could have refunded a share.
--
-- So there is NO money column anywhere below, and that absence is the
-- enforcement. RISK-10's hard rule is "no partial mid-tenancy refunds"; the
-- way to make that true is to build no field and no code path that could
-- pay one. Departing roommates settle between themselves, and the amendment
-- everybody signs says so in as many words.

-- No DRAFT. A change is created by the same action that sends its
-- amendment for signature: a half-filled roommate change nobody has been
-- asked to sign is a decision somebody is still making, not a record.
CREATE TYPE "PartyChangeStatus" AS ENUM ('PENDING_SIGNATURE', 'COMPLETED', 'VOIDED');

CREATE TYPE "PartyChangeDirection" AS ENUM ('OUTGOING', 'INCOMING');

-- R-063's LeaseEnvelope now carries two meanings. The default keeps every
-- existing row (and every existing writer) saying exactly what it said
-- before.
CREATE TYPE "LeaseEnvelopeKind" AS ENUM ('LEASE', 'AMENDMENT');

ALTER TABLE "LeaseEnvelope"
  ADD COLUMN "kind" "LeaseEnvelopeKind" NOT NULL DEFAULT 'LEASE';

-- An amendment's text is generated from the facts of the change, not from a
-- PM-authored template: there is nothing in it for an author to write that
-- is not already a field, and requiring a template would mean a portfolio
-- could not run a roommate change until somebody seeded one.
ALTER TABLE "LeaseEnvelope"
  ALTER COLUMN "templateId" DROP NOT NULL;

-- A LEASE envelope still must have one. The rule that was a NOT NULL is now
-- a CHECK that says which kind it applies to, rather than being dropped.
ALTER TABLE "LeaseEnvelope"
  ADD CONSTRAINT "LeaseEnvelope_lease_kind_needs_template"
  CHECK ("kind" <> 'LEASE' OR "templateId" IS NOT NULL);

CREATE TABLE "LeasePartyChange" (
  "id"               TEXT NOT NULL,
  "leaseId"          TEXT NOT NULL,
  "status"           "PartyChangeStatus" NOT NULL DEFAULT 'PENDING_SIGNATURE',
  -- Recorded and printed on the amendment, but NOT a scheduler: the change
  -- applies when the last signature lands, never on a timer. A future date
  -- that quietly took somebody's portal access and stopped their notices
  -- before they had actually moved out is the failure mode avoided.
  "effectiveOn"      DATE NOT NULL,
  "reason"           TEXT NOT NULL,
  "envelopeId"       TEXT,
  "appliedAt"        TIMESTAMP(3),
  "voidedAt"         TIMESTAMP(3),
  "voidReason"       TEXT,
  "createdByStaffId" TEXT NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LeasePartyChange_pkey" PRIMARY KEY ("id"),
  -- Each of the three states carries exactly the timestamps it claims. A
  -- COMPLETED change with no `appliedAt` would be a change nobody can date,
  -- which is the one question a later dispute asks.
  CONSTRAINT "LeasePartyChange_applied_when_completed"
    CHECK (("status" = 'COMPLETED') = ("appliedAt" IS NOT NULL)),
  CONSTRAINT "LeasePartyChange_voided_with_reason"
    CHECK (("status" = 'VOIDED') = ("voidedAt" IS NOT NULL AND "voidReason" IS NOT NULL))
);

CREATE UNIQUE INDEX "LeasePartyChange_envelopeId_key" ON "LeasePartyChange"("envelopeId");
CREATE INDEX "LeasePartyChange_leaseId_status_idx" ON "LeasePartyChange"("leaseId", "status");

CREATE TABLE "LeasePartyChangeParty" (
  "id"          TEXT NOT NULL,
  "changeId"    TEXT NOT NULL,
  "direction"   "PartyChangeDirection" NOT NULL,
  -- NOT NULL in both directions. An incoming party's Tenant row is created
  -- when the amendment is SENT, not when it completes: they have to be a
  -- real, addressable party to receive a signing link at all, and a
  -- LeaseSigner with neither a tenantId nor a guarantorId is a signature
  -- attributable to nobody.
  "tenantId"    TEXT NOT NULL,
  "applicantId" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LeasePartyChangeParty_pkey" PRIMARY KEY ("id"),
  -- RISK-10's "replacement screened to full criteria", made unfalsifiable:
  -- a replacement with no screening record cannot exist in this table.
  -- Whether that screening was APPROVED is checked in the action - a
  -- decision is a column on ScreeningReport that a CHECK here cannot reach -
  -- but "nobody screened them at all" is settled here, in Postgres.
  CONSTRAINT "LeasePartyChangeParty_incoming_needs_applicant"
    CHECK ("direction" <> 'INCOMING' OR "applicantId" IS NOT NULL)
);

CREATE UNIQUE INDEX "LeasePartyChangeParty_changeId_tenantId_key"
  ON "LeasePartyChangeParty"("changeId", "tenantId");
CREATE INDEX "LeasePartyChangeParty_tenantId_idx" ON "LeasePartyChangeParty"("tenantId");

ALTER TABLE "LeasePartyChange"
  ADD CONSTRAINT "LeasePartyChange_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeasePartyChange"
  ADD CONSTRAINT "LeasePartyChange_envelopeId_fkey"
  FOREIGN KEY ("envelopeId") REFERENCES "LeaseEnvelope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeasePartyChange"
  ADD CONSTRAINT "LeasePartyChange_createdByStaffId_fkey"
  FOREIGN KEY ("createdByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeasePartyChangeParty"
  ADD CONSTRAINT "LeasePartyChangeParty_changeId_fkey"
  FOREIGN KEY ("changeId") REFERENCES "LeasePartyChange"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeasePartyChangeParty"
  ADD CONSTRAINT "LeasePartyChangeParty_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeasePartyChangeParty"
  ADD CONSTRAINT "LeasePartyChangeParty_applicantId_fkey"
  FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
