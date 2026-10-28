-- R-294b (PRD 11 §5.1, D-350): the platform admin identity. No org: a
-- platform admin is not inside any organisation.
ALTER TYPE "AuthTokenPurpose" ADD VALUE 'PLATFORM_MFA_CHALLENGE';
ALTER TYPE "AuthTokenPurpose" ADD VALUE 'PLATFORM_PASSWORD_SETUP';

CREATE TABLE "PlatformAdmin" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sessionsValidFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "deactivatedAt" TIMESTAMP(3),

    CONSTRAINT "PlatformAdmin_pkey" PRIMARY KEY ("id"),
    -- Uniqueness is case-insensitive because the value is always lower-case.
    CONSTRAINT "PlatformAdmin_email_lower_check" CHECK ("email" = lower("email"))
);

CREATE TABLE "PlatformCredential" (
    "id" TEXT NOT NULL,
    "platformAdminId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "passwordUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mfaSecret" TEXT,
    "mfaEnrolledAt" TIMESTAMP(3),
    "mfaRecoveryCodes" TEXT[],
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformAdmin_email_key" ON "PlatformAdmin"("email");
CREATE UNIQUE INDEX "PlatformCredential_platformAdminId_key" ON "PlatformCredential"("platformAdminId");

ALTER TABLE "PlatformAdmin" ADD CONSTRAINT "PlatformAdmin_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlatformCredential" ADD CONSTRAINT "PlatformCredential_platformAdminId_fkey" FOREIGN KEY ("platformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Audit rows name these ids, so neither table ever loses a row. Deactivation
-- is `active = false`.
CREATE FUNCTION reject_platform_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted; deactivate the admin instead.', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PlatformAdmin_no_delete" BEFORE DELETE ON "PlatformAdmin"
  FOR EACH ROW EXECUTE FUNCTION reject_platform_delete();
CREATE TRIGGER "PlatformAdmin_no_truncate" BEFORE TRUNCATE ON "PlatformAdmin"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_platform_delete();
CREATE TRIGGER "PlatformCredential_no_delete" BEFORE DELETE ON "PlatformCredential"
  FOR EACH ROW EXECUTE FUNCTION reject_platform_delete();
CREATE TRIGGER "PlatformCredential_no_truncate" BEFORE TRUNCATE ON "PlatformCredential"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_platform_delete();
