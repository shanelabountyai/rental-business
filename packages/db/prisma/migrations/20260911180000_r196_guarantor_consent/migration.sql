-- R-196: a guarantor can be the subject of a TCPA consent record.
--
-- R-179 put guarantors on the rent chase and, correctly, behind the consent
-- gate (D-190). But `TenantConsent` was keyed on `tenantId` alone, so a
-- guarantor id matched no row and every guarantor SMS was `no_consent` for
-- ever - with no column, form or path by which one could ever be recorded.
--
-- WIDENED, NOT RENAMED OR MADE POLYMORPHIC. The evidence is the same for
-- either person (basis, disclosure, who recorded it, withdrawal) and so is
-- the append-only guard: `tenant_consent_guard()` compares `to_jsonb(NEW)`
-- against `to_jsonb(OLD)` minus the two withdrawal columns, so the new
-- column is frozen by the existing trigger with no change to it. A
-- `subjectType`/`subjectId` pair would have given up both foreign keys.
--
-- NO BACKFILL (D-201). R-051b grandfathered the existing TENANT roster on
-- EXISTING_RELATIONSHIP; nothing does that for guarantors. A co-signer gave
-- us a number on a guaranty, not as part of a tenancy they live in, and
-- whether that is a relationship covering debt texts is exactly the claim a
-- person should assert on the record rather than a migration asserting it
-- for everybody.

ALTER TABLE "TenantConsent" ALTER COLUMN "tenantId" DROP NOT NULL;
ALTER TABLE "TenantConsent" ADD COLUMN "guarantorId" TEXT;

-- Exactly one person. Neither would be a consent nobody gave; both would be
-- one row read by two people's send paths.
ALTER TABLE "TenantConsent"
  ADD CONSTRAINT "TenantConsent_one_subject"
  CHECK (num_nonnulls("tenantId", "guarantorId") = 1);

CREATE INDEX "TenantConsent_guarantorId_channel_idx"
  ON "TenantConsent" ("guarantorId", "channel");

ALTER TABLE "TenantConsent" ADD CONSTRAINT "TenantConsent_guarantorId_fkey"
  FOREIGN KEY ("guarantorId") REFERENCES "Guarantor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
