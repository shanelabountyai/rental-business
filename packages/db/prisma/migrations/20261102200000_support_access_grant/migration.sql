-- R-295a (PRD 11 §4.7, §5.3, §5.4, D-353, D-380): support access grants, the
-- lifecycle half. Nothing here lets anybody into an org yet (R-295b).

-- CreateEnum
CREATE TYPE "SupportGrantKind" AS ENUM ('REQUESTED', 'BREAK_GLASS');

-- CreateEnum
CREATE TYPE "SupportGrantEndedBy" AS ENUM ('PLATFORM', 'STAFF', 'SYSTEM', 'EXPIRY');

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "supportGrantId" TEXT;

-- CreateTable
CREATE TABLE "SupportAccessGrant" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "platformAdminId" TEXT NOT NULL,
    "kind" "SupportGrantKind" NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedMinutes" INTEGER NOT NULL,
    "approvedByStaffId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "deniedByStaffId" TEXT,
    "deniedAt" TIMESTAMP(3),
    "denialNote" TEXT,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedByType" "SupportGrantEndedBy",
    "endedById" TEXT,
    "ownersAcknowledgedAt" TIMESTAMP(3),
    "acknowledgedByStaffId" TEXT,

    CONSTRAINT "SupportAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportAccessGrant_orgId_requestedAt_idx" ON "SupportAccessGrant"("orgId", "requestedAt");

-- CreateIndex
CREATE INDEX "SupportAccessGrant_platformAdminId_requestedAt_idx" ON "SupportAccessGrant"("platformAdminId", "requestedAt");

-- CreateIndex
CREATE INDEX "AuditLog_supportGrantId_idx" ON "AuditLog"("supportGrantId");

-- AddForeignKey
ALTER TABLE "SupportAccessGrant" ADD CONSTRAINT "SupportAccessGrant_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccessGrant" ADD CONSTRAINT "SupportAccessGrant_platformAdminId_fkey" FOREIGN KEY ("platformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccessGrant" ADD CONSTRAINT "SupportAccessGrant_approvedByStaffId_fkey" FOREIGN KEY ("approvedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccessGrant" ADD CONSTRAINT "SupportAccessGrant_deniedByStaffId_fkey" FOREIGN KEY ("deniedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccessGrant" ADD CONSTRAINT "SupportAccessGrant_acknowledgedByStaffId_fkey" FOREIGN KEY ("acknowledgedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_supportGrantId_fkey" FOREIGN KEY ("supportGrantId") REFERENCES "SupportAccessGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- §5.4: only a platform act names a grant. A staff member approving one
-- writes an ordinary STAFF row about it (entityType SupportAccessGrant).
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_support_grant_platform_check"
  CHECK ("supportGrantId" IS NULL OR "actorType" = 'PLATFORM');

-- §5.3's CHECKs. Each pair of "who" and "when" is set together.
ALTER TABLE "SupportAccessGrant"
  ADD CONSTRAINT "SupportAccessGrant_reason_check" CHECK (length(btrim("reason")) > 0),
  ADD CONSTRAINT "SupportAccessGrant_minutes_check" CHECK ("requestedMinutes" BETWEEN 1 AND 1440),
  ADD CONSTRAINT "SupportAccessGrant_approved_by_check" CHECK (("approvedAt" IS NULL) = ("approvedByStaffId" IS NULL)),
  ADD CONSTRAINT "SupportAccessGrant_denied_by_check" CHECK (("deniedAt" IS NULL) = ("deniedByStaffId" IS NULL)),
  ADD CONSTRAINT "SupportAccessGrant_ended_by_check" CHECK (("endedAt" IS NULL) = ("endedByType" IS NULL)),
  ADD CONSTRAINT "SupportAccessGrant_acknowledged_check" CHECK (
    ("ownersAcknowledgedAt" IS NULL) = ("acknowledgedByStaffId" IS NULL)
    AND ("ownersAcknowledgedAt" IS NULL OR "kind" = 'BREAK_GLASS')
  ),
  ADD CONSTRAINT "SupportAccessGrant_approved_or_denied_check" CHECK ("approvedAt" IS NULL OR "deniedAt" IS NULL),
  ADD CONSTRAINT "SupportAccessGrant_window_check" CHECK (
    ("startsAt" IS NULL) = ("expiresAt" IS NULL) AND ("expiresAt" IS NULL OR "expiresAt" > "startsAt")
  ),
  -- Break-glass: no approver, never denied, opens at once, at most an hour.
  ADD CONSTRAINT "SupportAccessGrant_break_glass_check" CHECK (
    "kind" <> 'BREAK_GLASS' OR (
      "approvedByStaffId" IS NULL AND "deniedAt" IS NULL AND "startsAt" IS NOT NULL
      AND "expiresAt" - "startsAt" <= interval '60 minutes'
    )
  ),
  -- A request: a window only once approved, at most 24 hours and at most
  -- what was asked for.
  ADD CONSTRAINT "SupportAccessGrant_requested_check" CHECK (
    "kind" <> 'REQUESTED' OR (
      ("startsAt" IS NULL) = ("approvedAt" IS NULL)
      AND ("expiresAt" IS NULL OR (
        "expiresAt" - "startsAt" <= interval '24 hours'
        AND "expiresAt" - "startsAt" <= "requestedMinutes" * interval '1 minute'
      ))
    )
  );

-- One OPEN grant per (org, admin) and one OPEN break-glass per org. "Live"
-- needs now(), which an index cannot read, so the index is over OPEN rows -
-- not ended and not denied - and every writer that opens a grant first stamps
-- EXPIRY on that org's expired-but-unstamped rows in the same transaction
-- (`expireSupportGrants`), so an expired grant never blocks a new one while it
-- waits for the nightly sweep. Expression indexes, as
-- PlatformRoleAssignment_one_live_grant is, because Prisma cannot express a
-- partial unique and would report a plain-column one as drift.
CREATE UNIQUE INDEX "SupportAccessGrant_one_open_per_admin"
  ON "SupportAccessGrant" (("orgId" || ':' || "platformAdminId"))
  WHERE "endedAt" IS NULL AND "deniedAt" IS NULL;
CREATE UNIQUE INDEX "SupportAccessGrant_one_open_break_glass"
  ON "SupportAccessGrant" (("orgId" || ':break-glass'))
  WHERE "kind" = 'BREAK_GLASS' AND "endedAt" IS NULL;

-- Never deleted: audit rows and the org's history name it.
CREATE FUNCTION reject_support_grant_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'SupportAccessGrant rows are never deleted; end the grant instead.'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SupportAccessGrant_no_delete" BEFORE DELETE ON "SupportAccessGrant"
  FOR EACH ROW EXECUTE FUNCTION reject_support_grant_delete();
CREATE TRIGGER "SupportAccessGrant_no_truncate" BEFORE TRUNCATE ON "SupportAccessGrant"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_support_grant_delete();

-- Forward only. Identity never changes; every lifecycle column is written
-- once; a denied or ended grant changes only by its acknowledgement; and only
-- a pending request may be denied (approved → ended, never → denied).
CREATE FUNCTION support_grant_forward_only() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."orgId" IS DISTINCT FROM OLD."orgId"
     OR NEW."platformAdminId" IS DISTINCT FROM OLD."platformAdminId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
     OR NEW."requestedMinutes" IS DISTINCT FROM OLD."requestedMinutes" THEN
    RAISE EXCEPTION 'A support grant''s identity cannot change.' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD."approvedByStaffId" IS NOT NULL AND NEW."approvedByStaffId" IS DISTINCT FROM OLD."approvedByStaffId")
     OR (OLD."approvedAt" IS NOT NULL AND NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt")
     OR (OLD."deniedByStaffId" IS NOT NULL AND NEW."deniedByStaffId" IS DISTINCT FROM OLD."deniedByStaffId")
     OR (OLD."deniedAt" IS NOT NULL AND NEW."deniedAt" IS DISTINCT FROM OLD."deniedAt")
     OR (OLD."denialNote" IS NOT NULL AND NEW."denialNote" IS DISTINCT FROM OLD."denialNote")
     OR (OLD."startsAt" IS NOT NULL AND NEW."startsAt" IS DISTINCT FROM OLD."startsAt")
     OR (OLD."expiresAt" IS NOT NULL AND NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt")
     OR (OLD."endedAt" IS NOT NULL AND NEW."endedAt" IS DISTINCT FROM OLD."endedAt")
     OR (OLD."endedByType" IS NOT NULL AND NEW."endedByType" IS DISTINCT FROM OLD."endedByType")
     OR (OLD."endedById" IS NOT NULL AND NEW."endedById" IS DISTINCT FROM OLD."endedById")
     OR (OLD."ownersAcknowledgedAt" IS NOT NULL AND NEW."ownersAcknowledgedAt" IS DISTINCT FROM OLD."ownersAcknowledgedAt")
     OR (OLD."acknowledgedByStaffId" IS NOT NULL AND NEW."acknowledgedByStaffId" IS DISTINCT FROM OLD."acknowledgedByStaffId") THEN
    RAISE EXCEPTION 'A support grant only moves forward: a recorded step cannot change.' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD."endedAt" IS NOT NULL OR OLD."deniedAt" IS NOT NULL)
     AND (NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
          OR NEW."deniedAt" IS DISTINCT FROM OLD."deniedAt"
          OR NEW."denialNote" IS DISTINCT FROM OLD."denialNote"
          OR NEW."startsAt" IS DISTINCT FROM OLD."startsAt"
          OR NEW."endedAt" IS DISTINCT FROM OLD."endedAt") THEN
    RAISE EXCEPTION 'An ended or denied support grant cannot change.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."deniedAt" IS NULL AND NEW."deniedAt" IS NOT NULL AND OLD."approvedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'An approved support grant can be ended, not denied.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SupportAccessGrant_forward_only" BEFORE UPDATE ON "SupportAccessGrant"
  FOR EACH ROW EXECUTE FUNCTION support_grant_forward_only();

-- The approver is a live owner-member of the grant's org: an active staff
-- member with a live membership there and a live portfolio-wide owner grant
-- (no property, no entity). Deferred to commit, as staff_assignment_membership
-- is, so the check sees the state the transaction leaves behind.
CREATE FUNCTION support_grant_approver_check() RETURNS trigger AS $$
BEGIN
  IF NEW."approvedByStaffId" IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM "StaffUser" s
       JOIN "OrgMembership" m ON m."staffUserId" = s."id" AND m."orgId" = NEW."orgId" AND m."removedAt" IS NULL
       JOIN "StaffAssignment" a ON a."staffUserId" = s."id" AND a."orgId" = NEW."orgId" AND a."revokedAt" IS NULL
         AND a."propertyId" IS NULL AND a."legalEntityId" IS NULL
       JOIN "Role" r ON r."id" = a."roleId" AND r."key" = 'owner'
       WHERE s."id" = NEW."approvedByStaffId" AND s."active"
     ) THEN
    RAISE EXCEPTION 'Only a live owner of this organisation can approve support access.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "SupportAccessGrant_approver"
  AFTER INSERT OR UPDATE OF "approvedByStaffId" ON "SupportAccessGrant"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION support_grant_approver_check();

-- ORG-06: the org is the grant's subject, named by the platform writer, and
-- never moves.
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "SupportAccessGrant" FOR EACH ROW EXECUTE FUNCTION org_scope();
