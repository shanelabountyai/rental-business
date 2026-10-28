-- R-302a (PRD 11 §3, §5.2, D-351): platform roles as rows, and grants that
-- are revoked, never deleted. No org: the console is inside no organisation.

CREATE TABLE "PlatformRole" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[],

    CONSTRAINT "PlatformRole_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "PlatformRoleAssignment" (
    "id" TEXT NOT NULL,
    "platformAdminId" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "PlatformRoleAssignment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformRoleAssignment_platformAdminId_revokedAt_idx" ON "PlatformRoleAssignment"("platformAdminId", "revokedAt");

-- One live grant per (admin, role). An expression index, as
-- StaffAssignment_one_live_grant is, because Prisma cannot express a partial
-- unique and would report a plain-column one as drift.
CREATE UNIQUE INDEX "PlatformRoleAssignment_one_live_grant"
  ON "PlatformRoleAssignment" (("platformAdminId" || ':' || "roleKey"))
  WHERE "revokedAt" IS NULL;

ALTER TABLE "PlatformRoleAssignment" ADD CONSTRAINT "PlatformRoleAssignment_platformAdminId_fkey" FOREIGN KEY ("platformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlatformRoleAssignment" ADD CONSTRAINT "PlatformRoleAssignment_roleKey_fkey" FOREIGN KEY ("roleKey") REFERENCES "PlatformRole"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlatformRoleAssignment" ADD CONSTRAINT "PlatformRoleAssignment_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlatformRoleAssignment" ADD CONSTRAINT "PlatformRoleAssignment_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A grant is history: never deleted, and the only change it ever takes is
-- being revoked, once.
CREATE FUNCTION reject_platform_assignment_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PlatformRoleAssignment rows are never deleted; set revokedAt instead.'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PlatformRoleAssignment_no_delete" BEFORE DELETE ON "PlatformRoleAssignment"
  FOR EACH ROW EXECUTE FUNCTION reject_platform_assignment_delete();
CREATE TRIGGER "PlatformRoleAssignment_no_truncate" BEFORE TRUNCATE ON "PlatformRoleAssignment"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_platform_assignment_delete();

CREATE FUNCTION platform_assignment_revoke_only() RETURNS trigger AS $$
BEGIN
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'A revoked platform grant cannot change.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revokedAt" IS NULL
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."platformAdminId" IS DISTINCT FROM OLD."platformAdminId"
     OR NEW."roleKey" IS DISTINCT FROM OLD."roleKey"
     OR NEW."grantedById" IS DISTINCT FROM OLD."grantedById"
     OR NEW."grantedAt" IS DISTINCT FROM OLD."grantedAt" THEN
    RAISE EXCEPTION 'A platform grant may only be revoked (revokedAt, revokedById).' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PlatformRoleAssignment_revoke_only" BEFORE UPDATE ON "PlatformRoleAssignment"
  FOR EACH ROW EXECUTE FUNCTION platform_assignment_revoke_only();

-- THE LAST OWNER, IN THE DATABASE (§5.2). `platformRevokeRefusal` is the
-- message; this is the guarantee. Deferred to commit, as
-- staff_assignment_membership is, so a transaction may grant the new owner
-- and revoke the old in either order. "Once one has existed", so an empty
-- deployment is not refused before its bootstrap.
--
-- The advisory lock closes write skew: two transactions each revoking a
-- different one of the last two owners would otherwise each see the other's
-- grant still live and both commit. Taken at commit, it makes the second wait
-- for the first and then count what the first left.
CREATE FUNCTION platform_last_owner_check() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('platform_last_owner'));
  IF EXISTS (SELECT 1 FROM "PlatformRoleAssignment" WHERE "roleKey" = 'platform_owner')
     AND NOT EXISTS (
       SELECT 1 FROM "PlatformRoleAssignment" r
       JOIN "PlatformAdmin" a ON a."id" = r."platformAdminId"
       WHERE r."roleKey" = 'platform_owner' AND r."revokedAt" IS NULL AND a."active"
     ) THEN
    RAISE EXCEPTION 'This is the last platform owner. Add another owner before removing this one.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "PlatformRoleAssignment_last_owner"
  AFTER UPDATE ON "PlatformRoleAssignment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform_last_owner_check();
CREATE CONSTRAINT TRIGGER "PlatformAdmin_last_owner"
  AFTER UPDATE OF "active" ON "PlatformAdmin"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform_last_owner_check();

-- The three roles, so the backfill below has a row to point at. seed.mts
-- upserts the same rows from PLATFORM_ROLE_DEFINITIONS on every deploy, which
-- is what carries a permission added in code to the roles.
INSERT INTO "PlatformRole" ("key", "name", "permissions") VALUES
  ('platform_owner', 'Platform owner', ARRAY['org.read','org.create','org.configure','org.freeze','org.offboard','org.feeSet','integration.provision','grant.request','grant.breakGlass','job.rerun','jurisdiction.publish','platformAudit.read','platformAdmin.manage']),
  ('platform_support', 'Platform support', ARRAY['org.read','integration.provision','grant.request','grant.breakGlass','job.rerun','platformAudit.read']),
  ('platform_viewer', 'Platform viewer', ARRAY['org.read','platformAudit.read']);

-- Until now "the last owner" was the last active admin (R-294b), so every
-- active admin is an owner. Bootstrapped by a script, so no grantor.
INSERT INTO "PlatformRoleAssignment" ("id", "platformAdminId", "roleKey")
  SELECT 'pra_' || "id", "id", 'platform_owner' FROM "PlatformAdmin" WHERE "active";
