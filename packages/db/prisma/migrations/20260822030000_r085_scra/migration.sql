-- R-085 (RISK-12): the Servicemembers Civil Relief Act.
--
-- Three things, and each one is deliberately small because the machinery it
-- needs already exists:
--
--   * §3955 termination is a TENANT-GIVEN NOTICE with a federally computed
--     effective date, so it reuses Lease.noticeGivenAt/By/EffectiveOn from
--     R-066 and adds one column saying which limb of §3955(b) was invoked.
--   * The military-status "flag" the backlog asks for is R-084's
--     `military_scra` lease hold. No second boolean is added anywhere - two
--     places recording the same fact is how they disagree.
--   * §3931's affidavit needs a DMDC search, so there is a table for the
--     search and its certificate.
--
-- WHY THERE IS NO ADAPTER FOR THE LOOKUP. D-7 gives this product simulated
-- adapters where a real vendor API waits behind them. DMDC serves single
-- records through a web form returning a signed PDF and bulk requests
-- through an authenticated file upload; there is no per-tenant call to
-- simulate. So a human runs the search and this records that they did - the
-- same call D-15 made on the retail-cash rail, for the same reason: a driver
-- that invents results is untested code that looks finished.

CREATE TYPE "ScraTerminationBasis" AS ENUM ('ENTERED_SERVICE', 'PCS_OR_DEPLOYMENT');

-- THREE-VALUED, and the third value is the whole point. INDETERMINATE (DMDC
-- could not match on the identifiers given) is NOT NOT_IN_SERVICE. Signing
-- the §3931 affidavit on a no-match is how a knowingly false one gets
-- signed, and §3931(c) makes that a criminal offence.
CREATE TYPE "ScraLookupResult" AS ENUM ('IN_SERVICE', 'NOT_IN_SERVICE', 'INDETERMINATE');

-- Null for every ordinary termination. A column rather than a table because
-- a lease is terminated once.
ALTER TABLE "Lease" ADD COLUMN "scraTerminationBasis" "ScraTerminationBasis";

-- Did the tenant appear? NULLABLE ON PURPOSE, and null is not "no": 50
-- U.S.C. §3931 applies only where the defendant does not appear, so a
-- contested hearing needs no affidavit and a default one does. `affidavit
-- Readiness` treats an unanswered question as not established and gates the
-- judgment either way, which is the safe direction.
ALTER TABLE "EvictionCase" ADD COLUMN "tenantAppeared" BOOLEAN;

CREATE TABLE "ScraLookup" (
  "id"                    TEXT NOT NULL,
  "leaseId"               TEXT NOT NULL,
  "propertyId"            TEXT NOT NULL,
  -- Per TENANT, not per lease: the affidavit is about a named defendant, so
  -- a two-adult tenancy needs two searches.
  "tenantId"              TEXT NOT NULL,
  -- Null for a search run outside any case, which is the good time to run
  -- one - before an eviction is even opened.
  "evictionCaseId"        TEXT,
  "result"                "ScraLookupResult" NOT NULL,
  -- DATE, not a timestamp: it is what the certificate is dated and what
  -- staleness is measured from, and no timezone may touch a calendar day.
  "searchedOn"            DATE NOT NULL,
  "providerReference"     TEXT,
  "activeDutyStartOn"     DATE,
  "activeDutyEndOn"       DATE,
  "certificateDocumentId" TEXT,
  "notes"                 TEXT,
  "recordedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedByStaffId"     TEXT NOT NULL,

  CONSTRAINT "ScraLookup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScraLookup_certificateDocumentId_key"
  ON "ScraLookup"("certificateDocumentId");
CREATE INDEX "ScraLookup_leaseId_searchedOn_idx" ON "ScraLookup"("leaseId", "searchedOn");
CREATE INDEX "ScraLookup_evictionCaseId_idx" ON "ScraLookup"("evictionCaseId");
CREATE INDEX "ScraLookup_tenantId_idx" ON "ScraLookup"("tenantId");

ALTER TABLE "ScraLookup"
  ADD CONSTRAINT "ScraLookup_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScraLookup"
  ADD CONSTRAINT "ScraLookup_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScraLookup"
  ADD CONSTRAINT "ScraLookup_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScraLookup"
  ADD CONSTRAINT "ScraLookup_evictionCaseId_fkey"
  FOREIGN KEY ("evictionCaseId") REFERENCES "EvictionCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScraLookup"
  ADD CONSTRAINT "ScraLookup_certificateDocumentId_fkey"
  FOREIGN KEY ("certificateDocumentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Restrict, like every other key pointing at evidence: who ran the search is
-- part of what the affidavit is sworn on.
ALTER TABLE "ScraLookup"
  ADD CONSTRAINT "ScraLookup_recordedByStaffId_fkey"
  FOREIGN KEY ("recordedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Active-duty dates belong to IN_SERVICE and to nothing else. A NOT_IN_SERVICE
-- row carrying a service period is a contradiction somebody would later read
-- as evidence, so the database refuses it rather than trusting every writer.
ALTER TABLE "ScraLookup"
  ADD CONSTRAINT "ScraLookup_duty_dates_need_service"
  CHECK (
    "result" = 'IN_SERVICE'
    OR ("activeDutyStartOn" IS NULL AND "activeDutyEndOn" IS NULL)
  );
