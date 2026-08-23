-- R-089 (RISK-07): insurance claims.
--
-- THERE IS NO `repairCostCents` COLUMN ON THE CLAIM, and that is the whole
-- shape of this table. RISK-07 asks for "payout vs actual repair cost", and
-- the obvious build is a number typed off the adjuster's worksheet. D-19
-- already settled why not: the cost of a job is typed ONCE, on the work
-- order, and every downstream reader computes from that row. The backlog
-- calls the work-order → invoice → P&L chain "the specific place owners
-- abandon software", and it fails the same way every time - somebody types a
-- total a second time somewhere else, the two copies drift, and neither can
-- be trusted again. A claim LINKS work orders and sums `jobCostCents` over
-- them, so the claim's repair cost and the property's maintenance spend
-- cannot disagree.
--
-- The deductible and whether loss of rents is covered are not copied here
-- either. They are `InsurancePolicy`'s, which is why `policyId` is NOT NULL.

CREATE TYPE "CauseOfLoss" AS ENUM ('WATER', 'FIRE', 'WIND_HAIL', 'THEFT_VANDALISM', 'LIABILITY', 'OTHER');

-- Two values, the same call R-088 made: the STAGE a claim has reached is its
-- event log, not a column that has to be kept in step with it.
CREATE TYPE "ClaimStatus" AS ENUM ('OPEN', 'CLOSED');

CREATE TYPE "ClaimOutcome" AS ENUM ('PAID', 'PARTIALLY_PAID', 'DENIED', 'WITHDRAWN');

-- The split exists because the two halves are taxed differently:
-- loss-of-rents proceeds replace rent and are income; proceeds for physical
-- damage are not, in the ordinary case. Which half a payment belongs to is
-- knowable exactly once - when the cheque and its covering letter are in
-- front of somebody - and is not recoverable the following January from a
-- bank line reading "CLAIM SETTLEMENT". So it is NOT NULL.
CREATE TYPE "ClaimPaymentCategory" AS ENUM ('REPAIR', 'LOSS_OF_RENTS', 'CONTENTS', 'OTHER');

CREATE TYPE "ClaimEventKind" AS ENUM (
  'REPORTED',
  'ADJUSTER_ASSIGNED',
  'INSPECTION',
  'ESTIMATE_RECEIVED',
  'CORRESPONDENCE_IN',
  'CORRESPONDENCE_OUT',
  'OFFER',
  'NOTE'
);

CREATE TABLE "InsuranceClaim" (
  "id"          TEXT NOT NULL,
  "propertyId"  TEXT NOT NULL,
  "policyId"    TEXT NOT NULL,
  "claimNumber" TEXT,
  "cause"       "CauseOfLoss" NOT NULL,
  "description" TEXT NOT NULL,

  -- The gap between these two is what a disputed water claim turns on.
  "incidentAt"          TIMESTAMP(3) NOT NULL,
  "mitigationStartedAt" TIMESTAMP(3),
  "reportedAt"          TIMESTAMP(3),

  -- An adjuster is not a Vendor: that model is a dispatchable, payable trade
  -- contact carrying W-9 status, trades, service areas and emergency
  -- availability, none of which means anything here.
  "adjusterName"    TEXT,
  "adjusterCompany" TEXT,
  "adjusterPhone"   TEXT,
  "adjusterEmail"   TEXT,

  -- Loss-of-rents evidence. THE RENT IS NOT STORED: the lease's own
  -- rentCents is the best evidence there is, the unit's asking rent is the
  -- fallback once the tenancy has ended, and which one was used is part of
  -- the answer rather than an implementation detail.
  "lossOfRentsUnitId"  TEXT,
  "lossOfRentsLeaseId" TEXT,
  "lossOfRentsFromOn"  DATE,
  "lossOfRentsToOn"    DATE,

  "status"      "ClaimStatus" NOT NULL DEFAULT 'OPEN',
  "outcome"     "ClaimOutcome",
  "outcomeNote" TEXT,

  "openedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "openedByStaffId" TEXT NOT NULL,
  "closedAt"        TIMESTAMP(3),

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InsuranceClaim_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InsuranceClaim_propertyId_status_idx" ON "InsuranceClaim"("propertyId", "status");
CREATE INDEX "InsuranceClaim_policyId_idx" ON "InsuranceClaim"("policyId");
CREATE INDEX "InsuranceClaim_status_openedAt_idx" ON "InsuranceClaim"("status", "openedAt");
CREATE INDEX "InsuranceClaim_lossOfRentsUnitId_idx" ON "InsuranceClaim"("lossOfRentsUnitId");
CREATE INDEX "InsuranceClaim_lossOfRentsLeaseId_idx" ON "InsuranceClaim"("lossOfRentsLeaseId");

ALTER TABLE "InsuranceClaim"
  ADD CONSTRAINT "InsuranceClaim_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsuranceClaim"
  ADD CONSTRAINT "InsuranceClaim_policyId_fkey"
  FOREIGN KEY ("policyId") REFERENCES "InsurancePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsuranceClaim"
  ADD CONSTRAINT "InsuranceClaim_openedByStaffId_fkey"
  FOREIGN KEY ("openedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- RESTRICT, explicitly: SetNull would quietly erase which tenancy's rent was
-- lost, which is the whole of a loss-of-rents figure's provenance.
ALTER TABLE "InsuranceClaim"
  ADD CONSTRAINT "InsuranceClaim_lossOfRentsUnitId_fkey"
  FOREIGN KEY ("lossOfRentsUnitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsuranceClaim"
  ADD CONSTRAINT "InsuranceClaim_lossOfRentsLeaseId_fkey"
  FOREIGN KEY ("lossOfRentsLeaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Its own table rather than a total on the claim, for the reason EvictionCost
-- has one: a settlement usually arrives as several cheques over months - an
-- advance on mitigation, then the building, then the rents - and a single
-- total cannot say when any of it landed. The tax export reads these rows
-- directly, exactly as it reads EvictionCost, because LedgerEntry is strictly
-- lease-scoped and a property-level receipt has no route through it.
CREATE TABLE "InsuranceClaimPayment" (
  "id"                TEXT NOT NULL,
  "claimId"           TEXT NOT NULL,
  "category"          "ClaimPaymentCategory" NOT NULL,
  "amountCents"       INTEGER NOT NULL,
  "receivedOn"        DATE NOT NULL,
  "reference"         TEXT,
  "note"              TEXT,
  "recordedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedByStaffId" TEXT NOT NULL,

  CONSTRAINT "InsuranceClaimPayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InsuranceClaimPayment_claimId_receivedOn_idx"
  ON "InsuranceClaimPayment"("claimId", "receivedOn");

-- CASCADE from the claim, the call R-087's attempts and R-088's observations
-- both make: a payment row has no meaning apart from its claim, and nothing
-- else points at one.
ALTER TABLE "InsuranceClaimPayment"
  ADD CONSTRAINT "InsuranceClaimPayment_claimId_fkey"
  FOREIGN KEY ("claimId") REFERENCES "InsuranceClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InsuranceClaimPayment"
  ADD CONSTRAINT "InsuranceClaimPayment_recordedByStaffId_fkey"
  FOREIGN KEY ("recordedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A payment of zero is not a payment, and a negative one is a recovery going
-- the wrong way. A carrier clawing money back happens and is a real event -
-- it is recorded as an event with a note, not as a negative receipt that
-- would quietly reduce reported income in whichever year it landed.
ALTER TABLE "InsuranceClaimPayment"
  ADD CONSTRAINT "InsuranceClaimPayment_amount_is_positive"
  CHECK ("amountCents" > 0);

CREATE TABLE "InsuranceClaimEvent" (
  "id"                TEXT NOT NULL,
  "claimId"           TEXT NOT NULL,
  "kind"              "ClaimEventKind" NOT NULL,
  "occurredAt"        TIMESTAMP(3) NOT NULL,
  "note"              TEXT NOT NULL,
  "documentId"        TEXT,
  "recordedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedByStaffId" TEXT NOT NULL,

  CONSTRAINT "InsuranceClaimEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InsuranceClaimEvent_claimId_occurredAt_idx"
  ON "InsuranceClaimEvent"("claimId", "occurredAt");

ALTER TABLE "InsuranceClaimEvent"
  ADD CONSTRAINT "InsuranceClaimEvent_claimId_fkey"
  FOREIGN KEY ("claimId") REFERENCES "InsuranceClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InsuranceClaimEvent"
  ADD CONSTRAINT "InsuranceClaimEvent_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InsuranceClaimEvent"
  ADD CONSTRAINT "InsuranceClaimEvent_recordedByStaffId_fkey"
  FOREIGN KEY ("recordedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The work orders being recovered under the claim. RESTRICT, so a claim
-- cannot be deleted out from under the jobs whose cost it reports.
--
-- Being on a claim does NOT exclude a job from the expense export the way a
-- CapitalImprovement or a split invoice does. A repair paid for by insurance
-- is still a deductible repair; the PROCEEDS are the offsetting item. A sixth
-- exclusion door here would delete the deduction AND leave the proceeds
-- unreported, which is the wrong answer twice, so the reconciliation identity
-- in packages/core/tax is deliberately untouched by this migration.
ALTER TABLE "WorkOrder" ADD COLUMN "insuranceClaimId" TEXT;
CREATE INDEX "WorkOrder_insuranceClaimId_idx" ON "WorkOrder"("insuranceClaimId");
ALTER TABLE "WorkOrder"
  ADD CONSTRAINT "WorkOrder_insuranceClaimId_fkey"
  FOREIGN KEY ("insuranceClaimId") REFERENCES "InsuranceClaim"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Loss photographs and video attach to the CLAIM, not to an event. The first
-- thing anybody does at a fresh loss is photograph everything, before there
-- is any correspondence to file it against, and a prompt that demanded an
-- event first is one nobody completes while standing in six inches of water.
ALTER TABLE "Document" ADD COLUMN "insuranceClaimId" TEXT;
CREATE INDEX "Document_insuranceClaimId_idx" ON "Document"("insuranceClaimId");
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_insuranceClaimId_fkey"
  FOREIGN KEY ("insuranceClaimId") REFERENCES "InsuranceClaim"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- A CLOSED claim says how it ended, the call AbandonmentCase, EvictionCase
-- and ViolationCase all make.
ALTER TABLE "InsuranceClaim"
  ADD CONSTRAINT "InsuranceClaim_closed_says_how"
  CHECK ("status" <> 'CLOSED' OR ("outcome" IS NOT NULL AND "outcomeNote" IS NOT NULL));

-- A loss-of-rents period is a period: both ends, or neither, and never
-- backwards. Without this a claim can carry a start date and no end and
-- report an open-ended, growing figure to an adjuster.
ALTER TABLE "InsuranceClaim"
  ADD CONSTRAINT "InsuranceClaim_loss_of_rents_is_a_period"
  CHECK (
    ("lossOfRentsFromOn" IS NULL AND "lossOfRentsToOn" IS NULL)
    OR (
      "lossOfRentsFromOn" IS NOT NULL
      AND "lossOfRentsToOn" IS NOT NULL
      AND "lossOfRentsToOn" >= "lossOfRentsFromOn"
      AND "lossOfRentsUnitId" IS NOT NULL
    )
  );
