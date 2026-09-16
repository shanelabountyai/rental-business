-- R-217: a habitability complaint is measured against a repair deadline
-- (MAINT-01/RISK-06; D-4).
--
-- NULLABLE, and null means "not configured" - never "no deadline applies".
-- The stall sweep watches no clock for a state without one, and
-- computeCoverage names the gap, rather than inventing a period.
ALTER TABLE "JurisdictionRule" ADD COLUMN "habitabilityRepairDays" INTEGER;

ALTER TABLE "JurisdictionRule" ADD CONSTRAINT "JurisdictionRule_habitabilityRepairDays_nonnegative"
  CHECK ("habitabilityRepairDays" IS NULL OR "habitabilityRepairDays" >= 0);

-- Texas: a rebuttable presumption that seven days is a reasonable time to
-- repair (Tex. Prop. Code §92.056(d)). Backfilled on the CURRENT statewide
-- rows only, the same way R-055 backfilled the retaliation window. Draft
-- configuration, not legal advice.
UPDATE "JurisdictionRule" SET "habitabilityRepairDays" = 7
  WHERE "state" = 'TX' AND "jurisdiction" IS NULL AND "effectiveTo" IS NULL;
