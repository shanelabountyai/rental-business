-- R-088 (RISK-02, RISK-03): unauthorized occupants and animals, and the
-- conditions a hoarding case is actually enforced on.
--
-- THERE IS NO `HOARDING` VALUE IN `ViolationKind`, AND ITS ABSENCE IS THE
-- DESIGN. You cannot serve a notice for hoarding: there is no lease term
-- against it and no code section naming it. What is enforceable is the
-- blocked exit, the pest harborage, the furnace nobody can reach. Hoarding
-- disorder is also a recognised disability, which makes a case file headed
-- with the word both unenforceable and the most quotable document in the
-- complaint that follows. A hoarding case is a PREMISES_CONDITION case whose
-- observations each name a ground from a closed list, and that list contains
-- no word for a person - the enum is the guardrail, because a free-text box
-- is where "hoarder" gets typed.

-- ---------------------------------------------------------------------------
-- Part 1: widen the accommodation table from animals to the general FHA
-- framework.
--
-- RISK-03 asks for reasonable-accommodation tracking on a hoarding case, and
-- the accommodation asked for there is never an animal - it is time, or a
-- support person at an inspection, or an exception to a storage rule. The
-- choice was to widen R-086's table or stand a second one beside it, and two
-- tables recording the same statutory process is two vocabularies to keep in
-- step, one of which will rot. The SHAPE needed no change: the two
-- observations that decide whether documentation may be asked for are the
-- Joint Statement's general rule, not an animal rule.
-- ---------------------------------------------------------------------------

-- Swapped rather than `ALTER TYPE ... ADD VALUE`, which cannot be used in the
-- same transaction it is added in. This is the shape Prisma itself generates.
CREATE TYPE "AccommodationKind" AS ENUM ('SERVICE_ANIMAL', 'ASSISTANCE_ANIMAL', 'POLICY_EXCEPTION');

ALTER TABLE "AccommodationRequest"
  ALTER COLUMN "kind" TYPE "AccommodationKind"
  USING ("kind"::text::"AccommodationKind");

DROP TYPE "AssistanceAnimalKind";

-- Postgres carries a CHECK constraint's expression across a column rename by
-- attribute number, so `AccommodationRequest_approval_names_the_animal` keeps
-- working against the new name. Its NAME is now wrong, so it is replaced
-- rather than left to mislead the next reader.
ALTER TABLE "AccommodationRequest" RENAME COLUMN "animalDescription" TO "subjectDescription";

ALTER TABLE "AccommodationRequest"
  DROP CONSTRAINT "AccommodationRequest_approval_names_the_animal";

-- An approval has to say what was approved: which animal, or exactly what
-- exception was agreed and for how long. An approval against an unrecorded
-- scope is what the disagreement two years from now is about.
ALTER TABLE "AccommodationRequest"
  ADD CONSTRAINT "AccommodationRequest_approval_names_its_subject"
  CHECK ("status" <> 'APPROVED' OR "subjectDescription" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Part 2: the cure period for a non-monetary breach (D-4).
--
-- Distinct from `payOrQuitDays`, which is the nonpayment clock. Most states
-- set the two differently and several set no cure period at all for some
-- breaches. Null = this product has not been taught the state's period, and
-- `cureClock` then reports the clock running with NO deadline rather than as
-- expired: a deadline this product invented is the one number in a case file
-- that must never be guessed.
-- ---------------------------------------------------------------------------

ALTER TABLE "JurisdictionRule" ADD COLUMN "leaseViolationCureDays" INTEGER;

-- ---------------------------------------------------------------------------
-- Part 3: the case file.
-- ---------------------------------------------------------------------------

CREATE TYPE "ViolationKind" AS ENUM ('UNAUTHORIZED_OCCUPANT', 'UNAUTHORIZED_ANIMAL', 'PREMISES_CONDITION');

-- Every value is something a notice could actually cite, and none of them
-- describes a person, their housekeeping or their health.
CREATE TYPE "ViolationGround" AS ENUM (
  'BLOCKED_EGRESS',
  'FIRE_LOAD',
  'PEST_HARBORAGE',
  'SANITATION',
  'SYSTEMS_INACCESSIBLE'
);

-- Two, deliberately. The stage a case has reached is the notice series
-- hanging off it, which `cureClock` reads from the NoticeDelivery rows. A
-- NOTICE_SERVED status here would be a second copy of that fact, and the two
-- would disagree the first time somebody recorded a service from the notices
-- screen.
CREATE TYPE "ViolationStatus" AS ENUM ('OPEN', 'CLOSED');

CREATE TYPE "ViolationOutcome" AS ENUM ('CURED', 'LEGITIMIZED', 'ACCOMMODATED', 'WITHDRAWN', 'ESCALATED');

CREATE TABLE "ViolationCase" (
  "id"              TEXT NOT NULL,
  "propertyId"      TEXT NOT NULL,
  "unitId"          TEXT NOT NULL,
  "leaseId"         TEXT NOT NULL,
  "kind"            "ViolationKind" NOT NULL,
  "status"          "ViolationStatus" NOT NULL DEFAULT 'OPEN',
  "outcome"         "ViolationOutcome",
  "outcomeNote"     TEXT,
  -- Why the operator proceeded past a warning. Today that means escalating
  -- to eviction while an accommodation request is undecided.
  "overrideReason"  TEXT,
  "openedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "openedByStaffId" TEXT NOT NULL,
  "closedAt"        TIMESTAMP(3),

  -- The applicant an unauthorized occupant was legitimized through. NOT a
  -- Tenant: the fact that matters is that they went through an application
  -- and were screened against the current written criteria, and Applicant is
  -- where the screening report hangs.
  "legitimizedApplicantId" TEXT,
  -- The animal an unauthorized-animal case authorized. Text, because this
  -- product has no Pet entity (D-87) and inventing one here would reverse
  -- that decision by the back door.
  "authorizedAnimal"       TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ViolationCase_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ViolationCase_propertyId_status_idx" ON "ViolationCase"("propertyId", "status");
CREATE INDEX "ViolationCase_leaseId_idx" ON "ViolationCase"("leaseId");
CREATE INDEX "ViolationCase_status_openedAt_idx" ON "ViolationCase"("status", "openedAt");
CREATE INDEX "ViolationCase_legitimizedApplicantId_idx" ON "ViolationCase"("legitimizedApplicantId");

ALTER TABLE "ViolationCase"
  ADD CONSTRAINT "ViolationCase_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ViolationCase"
  ADD CONSTRAINT "ViolationCase_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ViolationCase"
  ADD CONSTRAINT "ViolationCase_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ViolationCase"
  ADD CONSTRAINT "ViolationCase_openedByStaffId_fkey"
  FOREIGN KEY ("openedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- RESTRICT, and explicitly so: deleting the screening record would erase the
-- proof that this occupant was held to the same criteria as everybody else,
-- which is the entire fair-housing defence the legitimize path exists to
-- create.
ALTER TABLE "ViolationCase"
  ADD CONSTRAINT "ViolationCase_legitimizedApplicantId_fkey"
  FOREIGN KEY ("legitimizedApplicantId") REFERENCES "Applicant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ViolationObservation" (
  "id"                TEXT NOT NULL,
  "caseId"            TEXT NOT NULL,
  "ground"            "ViolationGround",
  "observedOn"        DATE NOT NULL,
  "note"              TEXT NOT NULL,
  "recordedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedByStaffId" TEXT NOT NULL,

  CONSTRAINT "ViolationObservation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ViolationObservation_caseId_observedOn_idx"
  ON "ViolationObservation"("caseId", "observedOn");

-- CASCADE from the case, the same call R-087's contact attempts make: an
-- observation has no meaning apart from the case it belongs to, and nothing
-- else points at one. The case itself is what everything is Restricted
-- against.
ALTER TABLE "ViolationObservation"
  ADD CONSTRAINT "ViolationObservation_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "ViolationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ViolationObservation"
  ADD CONSTRAINT "ViolationObservation_recordedByStaffId_fkey"
  FOREIGN KEY ("recordedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Photographs hang off the OBSERVATION, not the case. A hoarding file is a
-- series of dated visits, and a photo that cannot say which visit it came
-- from proves the condition existed at some point - which is not what anybody
-- is arguing about.
ALTER TABLE "Document" ADD COLUMN "violationObservationId" TEXT;
CREATE INDEX "Document_violationObservationId_idx" ON "Document"("violationObservationId");
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_violationObservationId_fkey"
  FOREIGN KEY ("violationObservationId") REFERENCES "ViolationObservation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The notice series (RISK-03). Notices are R-051's, unchanged - this only
-- says which case they belong to.
ALTER TABLE "Notice" ADD COLUMN "violationCaseId" TEXT;
CREATE INDEX "Notice_violationCaseId_idx" ON "Notice"("violationCaseId");
ALTER TABLE "Notice"
  ADD CONSTRAINT "Notice_violationCaseId_fkey"
  FOREIGN KEY ("violationCaseId") REFERENCES "ViolationCase"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A hoarding case and the accommodation asked for in response to it are the
-- same conversation. Reading either without the other is how the escalation
-- gets made that the request was about to prevent.
ALTER TABLE "AccommodationRequest" ADD COLUMN "violationCaseId" TEXT;
CREATE INDEX "AccommodationRequest_violationCaseId_idx" ON "AccommodationRequest"("violationCaseId");
ALTER TABLE "AccommodationRequest"
  ADD CONSTRAINT "AccommodationRequest_violationCaseId_fkey"
  FOREIGN KEY ("violationCaseId") REFERENCES "ViolationCase"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Part 4: the records that would prove nothing.
-- ---------------------------------------------------------------------------

-- NOT ENFORCED HERE: that a `ground` is present on a premises-condition
-- observation and absent on the other two kinds. The rule needs the parent
-- case's `kind`, and Postgres refuses a subquery in a CHECK constraint. The
-- alternatives were a trigger or denormalising `kind` onto every observation,
-- and a second copy of the case's kind is a thing that can disagree with the
-- case. So `validateObservation` in packages/core/violations is the only
-- enforcement, which is a genuinely weaker guarantee than the constraints
-- below and is written down here rather than left to be discovered.

-- A CLOSED case says how it ended, the same call AbandonmentCase and
-- EvictionCase both make: "this is over" with no account of how is the record
-- that helps nobody a year later, which is when it gets read.
ALTER TABLE "ViolationCase"
  ADD CONSTRAINT "ViolationCase_closed_says_how"
  CHECK ("status" <> 'CLOSED' OR ("outcome" IS NOT NULL AND "outcomeNote" IS NOT NULL));

-- A condition is never legitimized. A blocked fire exit does not become
-- permitted by agreement, and offering that as an outcome is how the
-- agreement gets made. It is cured, or accommodated, or it is still open.
ALTER TABLE "ViolationCase"
  ADD CONSTRAINT "ViolationCase_conditions_are_not_legitimized"
  CHECK ("outcome" IS DISTINCT FROM 'LEGITIMIZED' OR "kind" <> 'PREMISES_CONDITION');

-- Legitimizing an occupant names the application it went through. An occupant
-- added without one was held to a different standard than the last person who
-- applied for a unit here, and this row is where that would be recorded.
ALTER TABLE "ViolationCase"
  ADD CONSTRAINT "ViolationCase_legitimized_occupant_was_screened"
  CHECK (
    "outcome" IS DISTINCT FROM 'LEGITIMIZED'
    OR "kind" <> 'UNAUTHORIZED_OCCUPANT'
    OR "legitimizedApplicantId" IS NOT NULL
  );

-- And legitimizing an animal names which animal.
ALTER TABLE "ViolationCase"
  ADD CONSTRAINT "ViolationCase_legitimized_animal_is_named"
  CHECK (
    "outcome" IS DISTINCT FROM 'LEGITIMIZED'
    OR "kind" <> 'UNAUTHORIZED_ANIMAL'
    OR "authorizedAnimal" IS NOT NULL
  );
