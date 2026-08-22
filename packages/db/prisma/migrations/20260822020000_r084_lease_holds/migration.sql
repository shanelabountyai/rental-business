-- R-084 (RISK-11, RISK-12): typed lease holds.
--
-- A hold declares that something about a tenancy has changed in a way the
-- automation must not walk into - a servicemember covered by the SCRA, a
-- bankruptcy stay, a dead tenant, a disputed balance, a payment plan, a
-- request not to be contacted.
--
-- WHAT THIS TABLE DELIBERATELY DOES NOT HOLD: the effects. There is no
-- `haltsLateFees` column and there will not be one. Effects are declared per
-- TYPE in packages/core/holds/index.ts, so "does a bankruptcy hold stop late
-- fees" cannot become a question about what somebody remembered to tick on a
-- Tuesday. 11 U.S.C. §362 does not care what was ticked.

CREATE TYPE "LeaseHoldType" AS ENUM (
  'MILITARY_SCRA',
  'DECEASED',
  'BANKRUPTCY',
  'DISPUTE',
  'PAYMENT_PLAN',
  'DO_NOT_CONTACT'
);

CREATE TABLE "LeaseHold" (
  "id"              TEXT NOT NULL,
  "leaseId"         TEXT NOT NULL,
  -- Denormalized from the lease so scoping and the per-property nightly
  -- sweeps filter without a join, matching Charge and LeasePayer.
  "propertyId"      TEXT NOT NULL,
  "type"            "LeaseHoldType" NOT NULL,
  -- NOT NULL with no default. A hold nobody can explain is worse than no
  -- hold: it is indistinguishable from a retaliatory one, which is the claim
  -- it will be defended against.
  "reason"          TEXT NOT NULL,
  "placedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "placedByStaffId" TEXT NOT NULL,
  -- Null while in force. A lifted hold KEEPS ITS ROW - "was the stay in force
  -- on the day that notice was served" is answerable only from a row that
  -- survived being lifted, so a tenancy accumulates rows of the same type
  -- over its life with at most one of them active.
  "liftedAt"        TIMESTAMP(3),
  "liftedByStaffId" TEXT,
  "liftReason"      TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LeaseHold_pkey" PRIMARY KEY ("id")
);

-- NO PARTIAL UNIQUE INDEX on (leaseId, type) WHERE "liftedAt" IS NULL, even
-- though "at most one active hold of a type" is exactly what that expresses.
-- Prisma's schema cannot describe a partial index, so `prisma migrate diff
-- --exit-code` would report drift on every CI run for ever - which is the
-- SmsOptOut trap CLAUDE.md already names. `placeLeaseHold` enforces it
-- instead, and has to read the active holds anyway to tell the operator the
-- hold is already on.
CREATE INDEX "LeaseHold_leaseId_liftedAt_idx" ON "LeaseHold"("leaseId", "liftedAt");
CREATE INDEX "LeaseHold_propertyId_liftedAt_idx" ON "LeaseHold"("propertyId", "liftedAt");

ALTER TABLE "LeaseHold"
  ADD CONSTRAINT "LeaseHold_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaseHold"
  ADD CONSTRAINT "LeaseHold_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT on both staff keys, like every other key pointing at evidence:
-- who placed a hold, and who took it off, are part of explaining what
-- happened to a tenancy while it was on.
ALTER TABLE "LeaseHold"
  ADD CONSTRAINT "LeaseHold_placedByStaffId_fkey"
  FOREIGN KEY ("placedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaseHold"
  ADD CONSTRAINT "LeaseHold_liftedByStaffId_fkey"
  FOREIGN KEY ("liftedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A lift is three facts or none. A row with `liftedAt` set and no reason is
-- the exact record that cannot answer "on what basis did you resume
-- collecting from a bankrupt tenant", so the database refuses it rather than
-- trusting every future writer to remember.
ALTER TABLE "LeaseHold"
  ADD CONSTRAINT "LeaseHold_lift_is_complete"
  CHECK (
    ("liftedAt" IS NULL AND "liftedByStaffId" IS NULL AND "liftReason" IS NULL)
    OR ("liftedAt" IS NOT NULL AND "liftedByStaffId" IS NOT NULL AND "liftReason" IS NOT NULL)
  );
