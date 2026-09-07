-- R-175: a repayment plan becomes a schedule, not a free-text hold reason.
--
-- A `PAYMENT_PLAN` hold has until now carried a typed sentence and nothing
-- else. `LeaseHold.paymentPlanId` is what turns that hold into the visible
-- consequence of an agreement the product can actually check: the schedule
-- lives in PaymentPlan / PaymentPlanInstalment, and the nightly sweep breaks
-- the plan and lifts the hold when an instalment goes unpaid.
--
-- NOTHING IS BACKFILLED. An existing payment_plan hold keeps its free text
-- and a null plan; there is no schedule to invent for it, and guessing one
-- would put dates in front of an operator that nobody ever agreed. Those
-- holds go on working exactly as before and can be lifted by hand.

CREATE TYPE "PaymentPlanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'BROKEN', 'CANCELLED');

CREATE TABLE "PaymentPlan" (
  "id"                 TEXT NOT NULL,
  "leaseId"            TEXT NOT NULL,
  "propertyId"         TEXT NOT NULL,
  "status"             "PaymentPlanStatus" NOT NULL DEFAULT 'ACTIVE',
  "arrearsCents"       INTEGER NOT NULL,
  "startedOn"          DATE NOT NULL,
  "note"               TEXT NOT NULL,
  "createdByStaffId"   TEXT NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "brokenAt"           TIMESTAMP(3),
  "brokenOn"           DATE,
  "completedAt"        TIMESTAMP(3),
  "cancelledAt"        TIMESTAMP(3),
  "cancelledByStaffId" TEXT,
  "cancelReason"       TEXT,

  CONSTRAINT "PaymentPlan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaymentPlan_leaseId_status_idx" ON "PaymentPlan"("leaseId", "status");
CREATE INDEX "PaymentPlan_propertyId_status_idx" ON "PaymentPlan"("propertyId", "status");

-- NO PARTIAL UNIQUE INDEX on (leaseId) WHERE status = 'ACTIVE', even though
-- "at most one active plan per tenancy" is exactly what that expresses. The
-- same call R-084's own migration made two tables up: Prisma's schema cannot
-- describe a partial index, so `prisma migrate diff --exit-code` would report
-- drift on every CI run for ever. `agreePaymentPlan` enforces it instead, and
-- has to read the active plan anyway to tell the operator there is one.

ALTER TABLE "PaymentPlan"
  ADD CONSTRAINT "PaymentPlan_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentPlan"
  ADD CONSTRAINT "PaymentPlan_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentPlan"
  ADD CONSTRAINT "PaymentPlan_createdByStaffId_fkey"
  FOREIGN KEY ("createdByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentPlan"
  ADD CONSTRAINT "PaymentPlan_cancelledByStaffId_fkey"
  FOREIGN KEY ("cancelledByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PaymentPlanInstalment" (
  "id"          TEXT NOT NULL,
  "planId"      TEXT NOT NULL,
  "sequence"    INTEGER NOT NULL,
  "dueOn"       DATE NOT NULL,
  "amountCents" INTEGER NOT NULL,

  CONSTRAINT "PaymentPlanInstalment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentPlanInstalment_planId_sequence_key"
  ON "PaymentPlanInstalment"("planId", "sequence");
CREATE INDEX "PaymentPlanInstalment_planId_dueOn_idx"
  ON "PaymentPlanInstalment"("planId", "dueOn");

ALTER TABLE "PaymentPlanInstalment"
  ADD CONSTRAINT "PaymentPlanInstalment_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "PaymentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeaseHold" ADD COLUMN "paymentPlanId" TEXT;

CREATE UNIQUE INDEX "LeaseHold_paymentPlanId_key" ON "LeaseHold"("paymentPlanId");

ALTER TABLE "LeaseHold"
  ADD CONSTRAINT "LeaseHold_paymentPlanId_fkey"
  FOREIGN KEY ("paymentPlanId") REFERENCES "PaymentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
