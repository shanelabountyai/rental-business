-- R-297 (PRD 10 §7.1, D-401): screening criteria and decision reasons per org.

-- Each org numbers its own criteria versions from 1. The existing rows are
-- all one org's already (R-285a derived orgId), so no renumbering.
DROP INDEX "ScreeningCriteria_version_key";
DROP INDEX "ScreeningCriteria_orgId_idx";
CREATE UNIQUE INDEX "ScreeningCriteria_orgId_version_key" ON "ScreeningCriteria"("orgId", "version");

-- The reason list becomes the org's, and each reason names its criterion.
CREATE TYPE "ScreeningCriterion" AS ENUM ('income', 'credit', 'eviction', 'criminal');

ALTER TABLE "ScreeningReport" DROP CONSTRAINT "ScreeningReport_decisionReasonCode_fkey";
ALTER TABLE "DecisionReason" DROP CONSTRAINT "DecisionReason_pkey";

-- The five placeholders were seeded with no org: they are org_0's.
ALTER TABLE "DecisionReason" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0',
ADD COLUMN "criterion" "ScreeningCriterion";
ALTER TABLE "DecisionReason" ALTER COLUMN "orgId" DROP DEFAULT;

UPDATE "DecisionReason" SET "criterion" = CASE "code"
    WHEN 'INCOME_BELOW_CRITERIA' THEN 'income'::"ScreeningCriterion"
    WHEN 'CREDIT_BELOW_CRITERIA' THEN 'credit'::"ScreeningCriterion"
    WHEN 'RENTAL_HISTORY' THEN 'eviction'::"ScreeningCriterion"
    WHEN 'CRIMINAL_HISTORY' THEN 'criminal'::"ScreeningCriterion"
END;
-- UNVERIFIED_INFORMATION rests on no written criterion, so it stays null and
-- can no longer be picked. Past decisions that recorded it keep it.

-- A report in another org that already cites a reason gets that reason
-- copied into its own org, so the composite key below holds.
INSERT INTO "DecisionReason" ("orgId", "code", "label", "criterion", "createdAt", "retiredAt")
SELECT DISTINCT sr."orgId", dr."code", dr."label", dr."criterion", dr."createdAt", dr."retiredAt"
FROM "ScreeningReport" sr
JOIN "DecisionReason" dr ON dr."code" = sr."decisionReasonCode" AND dr."orgId" = 'org_0'
WHERE sr."orgId" <> 'org_0';

ALTER TABLE "DecisionReason" ADD CONSTRAINT "DecisionReason_pkey" PRIMARY KEY ("orgId", "code");
ALTER TABLE "DecisionReason" ADD CONSTRAINT "DecisionReason_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScreeningReport" ADD CONSTRAINT "ScreeningReport_orgId_decisionReasonCode_fkey" FOREIGN KEY ("orgId", "decisionReasonCode") REFERENCES "DecisionReason"("orgId", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "DecisionReason" FOR EACH ROW EXECUTE FUNCTION org_scope();

ALTER TABLE "DecisionReason" ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON "DecisionReason" TO rental_rls
  USING ("orgId" = current_setting('app.org_id', true))
  WITH CHECK ("orgId" = current_setting('app.org_id', true));
