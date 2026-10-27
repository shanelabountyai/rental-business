-- R-294a (D-352): an audit row is in the org its writer names, never in
-- org #0 by default.
--
-- With a property, org_scope derives the org as before. Without one, the
-- `org_0` default used to file the row under org #0 silently - D-348's named
-- ceiling, and the reason a jurisdiction rule published by org #1's owner
-- would have been audited in org #0's trail. The default goes, and the CHECK
-- refuses an org-less row from anyone but a platform admin acting on the
-- platform itself. Existing rows all carry an org, so the CHECK validates.
ALTER TABLE "AuditLog" ALTER COLUMN "orgId" DROP DEFAULT;
ALTER TABLE "AuditLog" ALTER COLUMN "orgId" DROP NOT NULL;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_org_named_check"
  CHECK ("orgId" IS NOT NULL OR "actorType" = 'PLATFORM');
