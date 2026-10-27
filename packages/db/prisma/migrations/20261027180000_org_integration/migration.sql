-- R-275 (PRD 10 §1.2): per-org integration credentials. No org default
-- (D-348): a writer that names no org fails. orgId immutable via org_scope().
CREATE TYPE "IntegrationProvider" AS ENUM ('STRIPE', 'TWILIO', 'RESEND', 'QUICKBOOKS', 'ESIGN');

CREATE TABLE "OrgIntegration" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "statusReason" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgIntegration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrgIntegration_orgId_provider_key" ON "OrgIntegration"("orgId", "provider");

ALTER TABLE "OrgIntegration" ADD CONSTRAINT "OrgIntegration_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "OrgIntegration" FOR EACH ROW EXECUTE FUNCTION org_scope();
