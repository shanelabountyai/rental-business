-- LEGAL-03: a prospect can be the subject of a TCPA consent record.
--
-- `notify()` gated SMS on consent for TENANT and GUARANTOR only, so every
-- PROSPECT and APPLICANT text (pre-screen invite, showing reminders,
-- application invites) went out with no consent on file, and a co-applicant
-- could be texted at a number somebody else typed in. The gate now covers
-- both, which needs somewhere for a prospect's consent to live: the public
-- inquiry form's texting checkbox writes it here.
--
-- Widened exactly as R-196 widened it for guarantors, for the same reasons:
-- the existing append-only trigger freezes the new column with no change, and
-- a polymorphic subject would give up the foreign key. No applicant column:
-- the lead applicant inherits the prospect's consent (same person, same
-- number), and a co-applicant has no path to consent yet, so is never texted.

ALTER TYPE "ConsentSource" ADD VALUE 'WEB_FORM';

ALTER TABLE "TenantConsent" ADD COLUMN "prospectId" TEXT;

ALTER TABLE "TenantConsent" DROP CONSTRAINT "TenantConsent_one_subject";
ALTER TABLE "TenantConsent"
  ADD CONSTRAINT "TenantConsent_one_subject"
  CHECK (num_nonnulls("tenantId", "guarantorId", "prospectId") = 1);

CREATE INDEX "TenantConsent_prospectId_channel_idx"
  ON "TenantConsent" ("prospectId", "channel");

ALTER TABLE "TenantConsent" ADD CONSTRAINT "TenantConsent_prospectId_fkey"
  FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
