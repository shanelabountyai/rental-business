-- R-304a (PRD 10 §1.2, PRD 11 §4.5, §4.17, §5.6, D-323, D-370): an invitation
-- to join an organisation. The first of every org is a platform admin's, so
-- the inviter is (type, id) rather than a StaffUser FK.
--
-- `roleKey` references Role(key) rather than Role(id), so the console can
-- write one without reading Role, which PLAT-03 keeps off its allowlist.

CREATE TABLE "OrgInvite" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "invitedByType" "ActorType" NOT NULL,
    "invitedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgInvite_pkey" PRIMARY KEY ("id"),
    -- Matched against StaffUser.email, which is stored lower-case.
    CONSTRAINT "OrgInvite_email_lower_check" CHECK ("email" = lower("email")),
    CONSTRAINT "OrgInvite_invited_by_check" CHECK ("invitedByType" IN ('STAFF', 'PLATFORM')),
    -- Accepted and revoked are both terminal: an invite is one or the other.
    CONSTRAINT "OrgInvite_terminal_check" CHECK ("acceptedAt" IS NULL OR "revokedAt" IS NULL),
    CONSTRAINT "OrgInvite_accepted_by_check" CHECK (("acceptedAt" IS NULL) = ("acceptedById" IS NULL))
);

CREATE UNIQUE INDEX "OrgInvite_tokenHash_key" ON "OrgInvite"("tokenHash");
CREATE INDEX "OrgInvite_orgId_idx" ON "OrgInvite"("orgId");

ALTER TABLE "OrgInvite" ADD CONSTRAINT "OrgInvite_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrgInvite" ADD CONSTRAINT "OrgInvite_roleKey_fkey" FOREIGN KEY ("roleKey") REFERENCES "Role"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrgInvite" ADD CONSTRAINT "OrgInvite_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An invite's org is never changed, as OrgHealth's.
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "OrgInvite" FOR EACH ROW EXECUTE FUNCTION org_scope();
