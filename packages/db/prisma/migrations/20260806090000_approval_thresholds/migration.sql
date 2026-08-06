-- R-026: approval thresholds (MAINT-04, ROLE-02).
--
-- Additive only, every column nullable with no default. An existing entity
-- with no threshold set falls back to the constants in
-- packages/core/approvals, so nothing needs backfilling and no work order
-- changes behaviour on deploy.

ALTER TABLE "LegalEntity" ADD COLUMN "approvalThresholdCents" INTEGER;
ALTER TABLE "LegalEntity" ADD COLUMN "actualsTolerancePercent" INTEGER;
ALTER TABLE "LegalEntity" ADD COLUMN "bidThresholdCents" INTEGER;

ALTER TABLE "WorkOrder" ADD COLUMN "approvedAmountCents" INTEGER;
ALTER TABLE "WorkOrder" ADD COLUMN "denialReason" TEXT;
ALTER TABLE "WorkOrder" ADD COLUMN "approvalQuestion" TEXT;
