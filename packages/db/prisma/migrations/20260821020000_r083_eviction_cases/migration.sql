-- PAY-14 (R-083): the delinquency-to-eviction path as a case file.
--
-- Nothing here files anything anywhere. EvictionCase records what a human did
-- or is scheduled to do; EvictionCost is the first OWNER-side outlay in this
-- schema (a filing fee is not a LedgerEntry, which is a Stripe projection per
-- D-11, and not a Charge, which is billed to a tenant).
--
-- Notices are linked, never copied: Notice.evictionCaseId files R-051's
-- existing generated/served/proof-carrying row under a case.

CREATE TYPE "EvictionStage" AS ENUM ('NOTICE', 'FILING', 'COURT', 'JUDGMENT', 'WRIT', 'LOCKOUT', 'CLOSED');
CREATE TYPE "EvictionOutcome" AS ENUM ('PAID_AND_CURED', 'CASH_FOR_KEYS', 'VOLUNTARY_MOVE_OUT', 'JUDGMENT_FOR_OWNER', 'JUDGMENT_FOR_TENANT', 'DISMISSED', 'WITHDRAWN');

CREATE TABLE "EvictionCase" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "stage" "EvictionStage" NOT NULL DEFAULT 'NOTICE',
    "outcome" "EvictionOutcome",
    "outcomeNote" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedByStaffId" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "filedOn" DATE,
    "courtDate" TIMESTAMP(3),
    "judgmentOn" DATE,
    "writOn" DATE,
    "lockoutOn" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvictionCase_pkey" PRIMARY KEY ("id")
);

-- A closed case must say HOW it closed, and an open one must not claim an
-- outcome. Enforced here rather than only in the action for the same reason
-- R-051 put its proof rules in CHECK constraints: a row claiming to be closed
-- with no outcome is not a weaker record, it is a false one.
ALTER TABLE "EvictionCase" ADD CONSTRAINT "EvictionCase_closed_has_outcome"
  CHECK (("stage" = 'CLOSED') = ("outcome" IS NOT NULL));

CREATE INDEX "EvictionCase_propertyId_stage_idx" ON "EvictionCase"("propertyId", "stage");
CREATE INDEX "EvictionCase_leaseId_idx" ON "EvictionCase"("leaseId");

ALTER TABLE "EvictionCase" ADD CONSTRAINT "EvictionCase_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvictionCase" ADD CONSTRAINT "EvictionCase_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvictionCase" ADD CONSTRAINT "EvictionCase_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvictionCase" ADD CONSTRAINT "EvictionCase_openedByStaffId_fkey" FOREIGN KEY ("openedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "EvictionCost" (
    "id" TEXT NOT NULL,
    "evictionCaseId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "incurredOn" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "documentId" TEXT,
    "recordedByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvictionCost_pkey" PRIMARY KEY ("id")
);

-- A zero or negative cost line records nothing and would sit in the total
-- looking like evidence of a waived fee. Core refuses it too; this is the
-- backstop.
ALTER TABLE "EvictionCost" ADD CONSTRAINT "EvictionCost_amount_positive" CHECK ("amountCents" > 0);

CREATE INDEX "EvictionCost_evictionCaseId_idx" ON "EvictionCost"("evictionCaseId");

ALTER TABLE "EvictionCost" ADD CONSTRAINT "EvictionCost_evictionCaseId_fkey" FOREIGN KEY ("evictionCaseId") REFERENCES "EvictionCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvictionCost" ADD CONSTRAINT "EvictionCost_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EvictionCost" ADD CONSTRAINT "EvictionCost_recordedByStaffId_fkey" FOREIGN KEY ("recordedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Notice" ADD COLUMN "evictionCaseId" TEXT;

CREATE INDEX "Notice_evictionCaseId_idx" ON "Notice"("evictionCaseId");

-- RESTRICT, not the SET NULL an optional relation would default to: a notice
-- quietly losing its case link is exactly the evidence loss the lease and
-- applicant relations on this table are already explicit about.
ALTER TABLE "Notice" ADD CONSTRAINT "Notice_evictionCaseId_fkey" FOREIGN KEY ("evictionCaseId") REFERENCES "EvictionCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
