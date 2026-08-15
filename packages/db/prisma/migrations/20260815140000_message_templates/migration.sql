-- R-049: managed message templates with merge fields (COMM-03).
--
-- These are NOT the typed templates in packages/core/notifications. Those
-- render the product's own automated messages and the compiler checks them;
-- these are written by a property manager in a textarea and no compiler will
-- ever see them (D-44). What replaces the type checking: a closed merge-field
-- catalogue, validation on save, and preview before send.

-- NULL is not English. It means nobody ever asked, which is the honest state
-- for every tenant onboarded before this migration - and the reason the send
-- path treats it as "use the default" rather than as a recorded preference.
ALTER TABLE "Tenant" ADD COLUMN "preferredLocale" TEXT;

CREATE TABLE "MessageTemplate" (
  "id"               TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  -- ROUTINE or LEGAL. Deliberately TEXT rather than an enum, for the same
  -- reason Notice.type is: what counts as a legal notice is jurisdiction
  -- configuration (D-4). The closed pair of values lives in core.
  "kind"             TEXT NOT NULL,
  "subject"          TEXT,
  "body"             TEXT NOT NULL,
  -- Retired, never deleted. A message sent from a template is evidence, and
  -- the template it came from is part of explaining it.
  "active"           BOOLEAN NOT NULL DEFAULT true,
  "createdByStaffId" TEXT NOT NULL,
  "updatedByStaffId" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MessageTemplate_active_name_idx" ON "MessageTemplate" ("active", "name");

ALTER TABLE "MessageTemplate"
  ADD CONSTRAINT "MessageTemplate_createdByStaffId_fkey"
  FOREIGN KEY ("createdByStaffId") REFERENCES "StaffUser"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MessageTemplate"
  ADD CONSTRAINT "MessageTemplate_updatedByStaffId_fkey"
  FOREIGN KEY ("updatedByStaffId") REFERENCES "StaffUser"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "MessageTemplateTranslation" (
  "id"                TEXT NOT NULL,
  "templateId"        TEXT NOT NULL,
  -- BCP-47, matching Tenant.preferredLocale.
  "locale"            TEXT NOT NULL,
  "subject"           TEXT,
  "body"              TEXT NOT NULL,
  -- THE POINT OF THIS TABLE. COMM-03 permits machine translation for routine
  -- chat and forbids it for legal notices; once both are rows here, the only
  -- thing telling them apart is whether somebody with authority signed this
  -- one off. The product cannot verify an attorney reviewed it, so it records
  -- who and when and makes the claim auditable rather than pretending to
  -- check it.
  "approvedAt"        TIMESTAMP(3),
  "approvedByStaffId" TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MessageTemplateTranslation_pkey" PRIMARY KEY ("id")
);

-- One translation per language per template. Two Spanish versions is a
-- question nobody can answer at send time.
CREATE UNIQUE INDEX "MessageTemplateTranslation_templateId_locale_key"
  ON "MessageTemplateTranslation" ("templateId", "locale");

-- CASCADE here, unlike every other key in this schema, and deliberately: a
-- translation is part of its template rather than evidence in its own right,
-- and an orphaned translation of a template nobody can name is not something
-- the record is better for keeping. The template itself is retired rather
-- than deleted, so this fires only when somebody genuinely removes a draft.
ALTER TABLE "MessageTemplateTranslation"
  ADD CONSTRAINT "MessageTemplateTranslation_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MessageTemplateTranslation"
  ADD CONSTRAINT "MessageTemplateTranslation_approvedByStaffId_fkey"
  FOREIGN KEY ("approvedByStaffId") REFERENCES "StaffUser"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
