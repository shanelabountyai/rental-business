-- R-264 (PRD 08 B1): every saved state of a managed template, with who and
-- when. The app writes one row per save in the same transaction.

CREATE TABLE "MessageTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "savedByStaffId" TEXT NOT NULL,
    "restoredFromVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageTemplateVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessageTemplateVersion_templateId_version_key" ON "MessageTemplateVersion"("templateId", "version");

ALTER TABLE "MessageTemplateVersion" ADD CONSTRAINT "MessageTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MessageTemplateVersion" ADD CONSTRAINT "MessageTemplateVersion_savedByStaffId_fkey" FOREIGN KEY ("savedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: what each existing template says today becomes its version 1,
-- attributed to whoever last saved it. Earlier wording is not recoverable
-- here; the `template.saved` audit rows still hold it as before/after.
INSERT INTO "MessageTemplateVersion"
    ("id", "templateId", "version", "name", "kind", "subject", "body", "savedByStaffId", "createdAt")
SELECT
    'tplv_' || "id", "id", 1, "name", "kind", "subject", "body",
    COALESCE("updatedByStaffId", "createdByStaffId"), "updatedAt"
FROM "MessageTemplate";
