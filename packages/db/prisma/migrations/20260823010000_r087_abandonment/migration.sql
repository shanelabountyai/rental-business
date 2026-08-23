-- R-087 (RISK-01): tenant goes dark / abandonment.
--
-- THE RISK RUNS BOTH WAYS, and the schema is shaped by that. RISK-01's own
-- closing line names the headline failure - "done wrong, this converts to an
-- unlawful-eviction claim" - and the opposite failure is just as real: a unit
-- nobody has looked inside for six weeks with a burst pipe, a pet, or a
-- person who has died in it. So nothing here declares a unit abandoned. It
-- records what was tried, when the unit was entered and on what lawful
-- basis, and runs the two clocks the statutes turn on.

-- Three jurisdiction periods (D-4). The two halves are read in OPPOSITE
-- directions and that is deliberate: an unconfigured presumption period
-- warns and leaves the call with the human, like every other clock in this
-- product; an unconfigured storage period REFUSES disposal outright.
-- Disposal is the only irreversible step in the workflow.
ALTER TABLE "JurisdictionRule" ADD COLUMN "abandonmentPresumedAfterDays" INTEGER;
ALTER TABLE "JurisdictionRule" ADD COLUMN "belongingsStorageDays" INTEGER;
-- Null = not configured; 0 = expressly no notice needed. Two different
-- statements, and `disposalReadiness` treats them differently.
ALTER TABLE "JurisdictionRule" ADD COLUMN "belongingsNoticeDays" INTEGER;

CREATE TYPE "AbandonmentStatus" AS ENUM ('MONITORING', 'ENTERED', 'BELONGINGS_HELD', 'CLOSED');

CREATE TYPE "AbandonmentOutcome" AS ENUM (
  'TENANT_RETURNED',
  'TENANT_REACHED_AND_SURRENDERED',
  'DECEASED',
  'ABANDONED_AND_RECOVERED',
  'CONVERTED_TO_EVICTION'
);

-- Half of these send nothing at all: a door knock, a neighbour asked, a
-- police welfare check. That is why the attempts have their own table rather
-- than being recorded as Messages - doing that would either invent outbound
-- messages nobody sent or leave the most persuasive evidence off the record.
CREATE TYPE "ContactMethod" AS ENUM (
  'PHONE_CALL',
  'TEXT',
  'EMAIL',
  'LETTER',
  'DOOR_KNOCK',
  'EMERGENCY_CONTACT',
  'THIRD_PARTY',
  'WELFARE_AUTHORITY'
);

CREATE TYPE "ContactOutcome" AS ENUM ('NO_ANSWER', 'REACHED', 'UNDELIVERABLE', 'INFORMATION');

CREATE TABLE "AbandonmentCase" (
  "id"              TEXT NOT NULL,
  "propertyId"      TEXT NOT NULL,
  "unitId"          TEXT NOT NULL,
  "leaseId"         TEXT NOT NULL,
  "status"          "AbandonmentStatus" NOT NULL DEFAULT 'MONITORING',
  "outcome"         "AbandonmentOutcome",
  "outcomeNote"     TEXT,
  "openedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "openedByStaffId" TEXT NOT NULL,
  "closedAt"        TIMESTAMP(3),
  -- The last sign of the tenant. A calendar day; the silence clock measures
  -- from it and no timezone may touch it.
  "lastContactOn"   DATE,

  -- The welfare-check entry. The Notice behind it is the proof it was
  -- lawful - Notice already carries service and its own jurisdiction verdict
  -- (R-051), so this points at one rather than re-recording any of it.
  "enteredAt"       TIMESTAMP(3),
  "entryNoticeId"   TEXT,
  "entryFindings"   TEXT,

  -- THE CLOCK RUNS FROM WHEN THE THINGS WERE SECURED, not from when the
  -- tenant was last seen - a much earlier date somebody would otherwise
  -- reach for, and one that would shorten every storage period.
  "belongingsHeldFrom"     DATE,
  "belongingsInventory"    TEXT,
  "belongingsNoticeSentOn" DATE,
  "belongingsDisposedAt"   TIMESTAMP(3),

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AbandonmentCase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AbandonmentCase_entryNoticeId_key" ON "AbandonmentCase"("entryNoticeId");
CREATE INDEX "AbandonmentCase_propertyId_status_idx" ON "AbandonmentCase"("propertyId", "status");
CREATE INDEX "AbandonmentCase_leaseId_idx" ON "AbandonmentCase"("leaseId");

ALTER TABLE "AbandonmentCase"
  ADD CONSTRAINT "AbandonmentCase_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AbandonmentCase"
  ADD CONSTRAINT "AbandonmentCase_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AbandonmentCase"
  ADD CONSTRAINT "AbandonmentCase_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AbandonmentCase"
  ADD CONSTRAINT "AbandonmentCase_openedByStaffId_fkey"
  FOREIGN KEY ("openedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AbandonmentCase"
  ADD CONSTRAINT "AbandonmentCase_entryNoticeId_fkey"
  FOREIGN KEY ("entryNoticeId") REFERENCES "Notice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AbandonmentContactAttempt" (
  "id"                TEXT NOT NULL,
  "caseId"            TEXT NOT NULL,
  "method"            "ContactMethod" NOT NULL,
  "outcome"           "ContactOutcome" NOT NULL,
  "attemptedOn"       DATE NOT NULL,
  "note"              TEXT,
  "recordedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedByStaffId" TEXT NOT NULL,

  CONSTRAINT "AbandonmentContactAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AbandonmentContactAttempt_caseId_attemptedOn_idx"
  ON "AbandonmentContactAttempt"("caseId", "attemptedOn");

-- CASCADE from the case, and this is the one place in the workflow that is
-- not Restrict: an attempt has no meaning apart from the case it belongs to,
-- and nothing else in the product points at one. The case itself is what
-- everything else is Restricted against.
ALTER TABLE "AbandonmentContactAttempt"
  ADD CONSTRAINT "AbandonmentContactAttempt_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "AbandonmentCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AbandonmentContactAttempt"
  ADD CONSTRAINT "AbandonmentContactAttempt_recordedByStaffId_fkey"
  FOREIGN KEY ("recordedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Entry photos and the belongings inventory hang off the case.
ALTER TABLE "Document" ADD COLUMN "abandonmentCaseId" TEXT;
CREATE INDEX "Document_abandonmentCaseId_idx" ON "Document"("abandonmentCaseId");
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_abandonmentCaseId_fkey"
  FOREIGN KEY ("abandonmentCaseId") REFERENCES "AbandonmentCase"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- A CLOSED case says how it ended. Same shape EvictionCase's own outcome
-- rule takes: "this is over" with no account of how is the record that
-- helps nobody a year later.
ALTER TABLE "AbandonmentCase"
  ADD CONSTRAINT "AbandonmentCase_closed_says_how"
  CHECK ("status" <> 'CLOSED' OR ("outcome" IS NOT NULL AND "outcomeNote" IS NOT NULL));

-- An ENTERED case names when, and on what notice or none. `entryNoticeId`
-- is deliberately NOT required - an emergency entry and a tenant-permission
-- entry are both lawful with no notice at all (packages/core/entry) - but
-- the timestamp and the findings are, because an entry nobody wrote down is
-- the one that gets characterised later by the other side.
ALTER TABLE "AbandonmentCase"
  ADD CONSTRAINT "AbandonmentCase_entry_is_recorded"
  CHECK (
    "status" NOT IN ('ENTERED', 'BELONGINGS_HELD')
    OR ("enteredAt" IS NOT NULL AND "entryFindings" IS NOT NULL)
  );

-- Holding belongings means a date the clock runs from and an inventory of
-- what is being held. Without both, "we held their things for thirty days"
-- is a claim with nothing behind it.
ALTER TABLE "AbandonmentCase"
  ADD CONSTRAINT "AbandonmentCase_holding_has_a_clock"
  CHECK (
    "status" <> 'BELONGINGS_HELD'
    OR ("belongingsHeldFrom" IS NOT NULL AND "belongingsInventory" IS NOT NULL)
  );

-- Nothing may be recorded as disposed of without the hold that preceded it.
ALTER TABLE "AbandonmentCase"
  ADD CONSTRAINT "AbandonmentCase_disposal_follows_a_hold"
  CHECK ("belongingsDisposedAt" IS NULL OR "belongingsHeldFrom" IS NOT NULL);
