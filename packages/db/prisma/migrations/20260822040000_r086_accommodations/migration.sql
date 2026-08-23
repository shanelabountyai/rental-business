-- R-086 (RISK-13): assistance-animal accommodation requests.
--
-- THE DATES ARE THE PRODUCT. RISK-13 asks for dated records and an airtight
-- request-to-response timeline, because the common failure here is not a
-- wrong decision - it is no decision, arriving late, with nothing on file to
-- show when it was asked for. Silence is read as a denial. So every
-- transition gets its own column rather than being reconstructed from
-- AuditLog: the clock is read on every render, and a report that has to
-- replay an audit log to answer "how long has this been open" is one nobody
-- runs.
--
-- NO `Animal` TABLE, AND NO `Pet` TABLE. An approved request IS the
-- assistance-animal record. This product has never had a pet entity, and
-- inventing one so the "distinct from a pet" comparison has two sides would
-- be building an unrequested feature to make a sentence look tidy. The
-- distinction that matters is enforced at the MONEY - see
-- `PET_MONEY_TYPES`/`petMoneyAllowed` in packages/core/accommodations - not
-- at a type column somebody has to remember to read.

CREATE TYPE "AssistanceAnimalKind" AS ENUM ('SERVICE_ANIMAL', 'ASSISTANCE_ANIMAL');

CREATE TYPE "AccommodationRequestStatus" AS ENUM (
  'RECEIVED',
  'INFO_REQUESTED',
  'APPROVED',
  'DENIED',
  'WITHDRAWN'
);

CREATE TABLE "AccommodationRequest" (
  "id"                   TEXT NOT NULL,
  "propertyId"           TEXT NOT NULL,
  "leaseId"              TEXT NOT NULL,
  -- Nullable: the person with the disability may be a household member who
  -- is not on the lease, and their request is still a request. Refusing to
  -- record it because they are not a LeaseTenant would lose the very fact
  -- this table exists to prove was received.
  "tenantId"             TEXT,
  "requestedByName"      TEXT,
  "kind"                 "AssistanceAnimalKind" NOT NULL,
  "status"               "AccommodationRequestStatus" NOT NULL DEFAULT 'RECEIVED',
  "requestText"          TEXT NOT NULL,
  "animalDescription"    TEXT,
  -- The two observations that decide whether documentation may lawfully be
  -- requested, recorded AS ASSESSED AT INTAKE and never recomputed - the
  -- same posture NoticeDelivery.permittedByJurisdiction takes (D-48).
  "disabilityObservable" BOOLEAN NOT NULL DEFAULT false,
  "needObservable"       BOOLEAN NOT NULL DEFAULT false,
  -- DATE, not timestamp, on all three: the clock is measured in calendar
  -- days and no timezone may touch one.
  "receivedOn"           DATE NOT NULL,
  "infoRequestedOn"      DATE,
  "decidedOn"            DATE,
  "determinationText"    TEXT,
  "decidedByStaffId"     TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AccommodationRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccommodationRequest_leaseId_status_idx"
  ON "AccommodationRequest"("leaseId", "status");
CREATE INDEX "AccommodationRequest_propertyId_status_idx"
  ON "AccommodationRequest"("propertyId", "status");

ALTER TABLE "AccommodationRequest"
  ADD CONSTRAINT "AccommodationRequest_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AccommodationRequest"
  ADD CONSTRAINT "AccommodationRequest_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AccommodationRequest"
  ADD CONSTRAINT "AccommodationRequest_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Restrict, like every key pointing at evidence: who decided a fair-housing
-- request is part of defending it.
ALTER TABLE "AccommodationRequest"
  ADD CONSTRAINT "AccommodationRequest_decidedByStaffId_fkey"
  FOREIGN KEY ("decidedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Supporting documents (the requester's letter, our written determination as
-- sent) hang off the request.
ALTER TABLE "Document" ADD COLUMN "accommodationRequestId" TEXT;

CREATE INDEX "Document_accommodationRequestId_idx"
  ON "Document"("accommodationRequestId");

ALTER TABLE "Document"
  ADD CONSTRAINT "Document_accommodationRequestId_fkey"
  FOREIGN KEY ("accommodationRequestId") REFERENCES "AccommodationRequest"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- A DECIDED REQUEST IS THREE FACTS OR NONE, the same shape LeaseHold's lift
-- constraint takes. A row stamped APPROVED with no date, no author and no
-- written determination is precisely the record that cannot answer "when did
-- you decide, who decided, and on what basis" - which is the whole of what
-- RISK-13 asks for.
ALTER TABLE "AccommodationRequest"
  ADD CONSTRAINT "AccommodationRequest_decision_is_complete"
  CHECK (
    ("status" NOT IN ('APPROVED', 'DENIED'))
    OR ("decidedOn" IS NOT NULL AND "decidedByStaffId" IS NOT NULL AND "determinationText" IS NOT NULL)
  );

-- An approval has to say WHICH animal. A dispute two years later is about
-- exactly that, and "an assistance animal was approved" answers nothing.
ALTER TABLE "AccommodationRequest"
  ADD CONSTRAINT "AccommodationRequest_approval_names_the_animal"
  CHECK ("status" <> 'APPROVED' OR "animalDescription" IS NOT NULL);
