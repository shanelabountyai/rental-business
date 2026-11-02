-- R-291a (PRD 10 §5, D-383): an organisation is PROVISIONING until the
-- platform marks it live. R-300 adds FROZEN and OFFBOARDED to the same enum.
CREATE TYPE "OrgStatus" AS ENUM ('PROVISIONING', 'ACTIVE');

-- Every org that exists before this is in use - org #0 is production - so the
-- backfill is ACTIVE; only an org created from here on starts PROVISIONING.
ALTER TABLE "Organization" ADD COLUMN "status" "OrgStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Organization" ALTER COLUMN "status" SET DEFAULT 'PROVISIONING';

-- The checklist's three facts an owner states rather than the database
-- shows: "just me" (step 2), templates reviewed (step 4), the shared email
-- domain chosen (step 7). A closed set; who and when are in the audit log.
ALTER TABLE "Organization" ADD COLUMN "setupMarks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_setupMarks_check"
  CHECK ("setupMarks" <@ ARRAY['just_me', 'templates_reviewed', 'shared_email']::TEXT[]);

-- The derived step booleans, written in the org's own context (PRD 11 §5.5),
-- so the console reads the checklist without counting an org's rows.
ALTER TABLE "OrgHealth" ADD COLUMN "checklist" JSONB;
