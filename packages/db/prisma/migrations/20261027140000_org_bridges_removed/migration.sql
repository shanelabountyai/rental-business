-- R-301 (D-338, D-339, D-348): the two org #0 bridges come out.
--
-- 1. The 'org_0' default on every org-owned table with no org-owned parent.
--    Those rows keep whatever orgId the writer gave, so with the default a
--    writer that forgot the org put the row in org #0 silently - another
--    customer's vendor, tenant or template in this one. Without it the insert
--    fails NOT NULL. Tables WITH a parent keep their default: org_scope
--    overwrites it from the parent, and Prisma would otherwise demand an
--    orgId on every create the trigger already derives.
--    Kept on purpose: SmsOptOut (R-292) and ProcessedStripeEvent (R-277),
--    whose writers have no org yet.
ALTER TABLE "LegalEntity" ALTER COLUMN "orgId" DROP DEFAULT;
ALTER TABLE "Tenant" ALTER COLUMN "orgId" DROP DEFAULT;
ALTER TABLE "Vendor" ALTER COLUMN "orgId" DROP DEFAULT;
ALTER TABLE "MessageTemplate" ALTER COLUMN "orgId" DROP DEFAULT;
ALTER TABLE "Audience" ALTER COLUMN "orgId" DROP DEFAULT;
ALTER TABLE "DocumentTemplate" ALTER COLUMN "orgId" DROP DEFAULT;
ALTER TABLE "InspectionTemplate" ALTER COLUMN "orgId" DROP DEFAULT;
ALTER TABLE "PreventiveMaintenanceTemplate" ALTER COLUMN "orgId" DROP DEFAULT;
ALTER TABLE "ScreeningCriteria" ALTER COLUMN "orgId" DROP DEFAULT;
ALTER TABLE "MessagingSettings" ALTER COLUMN "orgId" DROP DEFAULT;
ALTER TABLE "NotificationPreference" ALTER COLUMN "orgId" DROP DEFAULT;

-- 2. A grant needs a live membership in its org, org #0 included. The
--    auto-enrol branch let any org #0 grant enrol its grantee, so a grant
--    written for a member of another org pulled them into org #0.
--    DEFERRED to commit, so a staff member, their membership and their grant
--    can be created in one nested write in any order.
DROP TRIGGER "staff_assignment_membership" ON "StaffAssignment";

CREATE OR REPLACE FUNCTION staff_assignment_membership() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "OrgMembership"
    WHERE "orgId" = NEW."orgId" AND "staffUserId" = NEW."staffUserId" AND "removedAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'StaffAssignment needs a live membership: staff % in organisation %', NEW."staffUserId", NEW."orgId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "staff_assignment_membership"
  AFTER INSERT OR UPDATE OF "orgId", "staffUserId" ON "StaffAssignment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION staff_assignment_membership();
