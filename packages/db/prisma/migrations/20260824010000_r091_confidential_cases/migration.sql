-- R-091 (RISK-04, ROLE-05): confidential safety cases.
--
-- NOTHING IN THIS MIGRATION SAYS WHAT IT PROTECTS, and that is deliberate
-- rather than coy. RISK-04 is domestic violence. ROLE-05 asks for
-- "confidential flags (e.g. DV-related records) visible only to Owner role".
-- A table called "DvCase", a route reading /dv/abc123, or an audit action
-- `dv.case_opened` each disclose the exact fact the access control exists to
-- hold - to anyone reading a schema dump, a browser history, a log line or a
-- database console. So every name outside the permission wall says
-- "confidential" and stops there.
--
-- THE CASE IS CONFIDENTIAL; ITS CONSEQUENCES CANNOT BE. The locks genuinely
-- have to be changed, which means a real work order a real dispatcher hands
-- to a real locksmith, visible on the ordinary maintenance screens. What must
-- never leak is WHY - so the job is an ordinary re-key carrying an
-- instruction about who may receive keys, and the link between the two is
-- held on THIS side. `WorkOrder` gains no column pointing back, because a
-- non-null "confidentialCaseId" on a work order would itself be the
-- disclosure.
--
-- NO DOCUMENT IS STORED. A protective order or police report uploaded as a
-- `Document` row would be readable by every role holding `document.read` -
-- the manager, the maintenance tech and the read-only partner. What is
-- recorded is that documentation of a stated class was produced and verified,
-- by whom, on what date. That is what a state's early-termination right
-- actually turns on, and it is the half that does not create a copy of a
-- survivor's protective order inside a property-management system.

CREATE TYPE "ConfidentialCaseStatus" AS ENUM ('OPEN', 'CLOSED');

-- The instruction the person at the door must not miss. Its own column
-- rather than part of `scope`, for the reason R-032b established for the pet
-- warning: a warning rendered as a bordered note above the address is read,
-- and one buried in a paragraph of work description is missed.
--
-- It names who IS authorized and never who is not. "Do not give keys to John
-- Smith" tells a locksmith something about a household that is not theirs to
-- know and that they may repeat; "release keys only to Jane Doe" is the same
-- protection with nothing disclosed.
ALTER TABLE "WorkOrder" ADD COLUMN "restrictedPartyNote" TEXT;

CREATE TABLE "ConfidentialCase" (
  "id"                         TEXT NOT NULL,
  "leaseId"                    TEXT NOT NULL,
  "status"                     "ConfidentialCaseStatus" NOT NULL DEFAULT 'OPEN',
  "summary"                    TEXT NOT NULL,
  -- Free text, because the restricted party is as often somebody with no
  -- record in this system as a co-tenant: an ex-partner who was never on the
  -- lease has no row to point at.
  "restrictedPartyName"        TEXT,
  -- Set as well when the restricted party IS on the lease, which is the case
  -- R-091b's bifurcation path acts on.
  "restrictedPartyTenantId"    TEXT,
  -- PROTECTIVE_ORDER / POLICE_REPORT / PROVIDER_STATEMENT. Text rather than
  -- an enum because WHICH classes a statute accepts is jurisdiction
  -- configuration (D-4) and belongs in JurisdictionRule, not in a shape this
  -- table fixes for all fifty states.
  "documentationType"          TEXT,
  "documentedOn"               DATE,
  "documentationSeenByStaffId" TEXT,
  "lockChangeWorkOrderId"      TEXT,
  "openedByStaffId"            TEXT NOT NULL,
  "openedAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt"                   TIMESTAMP(3),
  "closedNote"                 TEXT,
  "updatedAt"                  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ConfidentialCase_pkey" PRIMARY KEY ("id"),
  -- A closed case says how it ended. An open one has not ended.
  CONSTRAINT "ConfidentialCase_closed_with_note"
    CHECK (("status" = 'CLOSED') = ("closedAt" IS NOT NULL AND "closedNote" IS NOT NULL)),
  -- Documentation that nobody looked at on no particular date is not
  -- documentation. Either all three are present or none of them is - the
  -- early-termination right R-091b builds turns on exactly this row.
  CONSTRAINT "ConfidentialCase_documentation_is_whole"
    CHECK (
      ("documentationType" IS NULL AND "documentedOn" IS NULL AND "documentationSeenByStaffId" IS NULL)
      OR ("documentationType" IS NOT NULL AND "documentedOn" IS NOT NULL AND "documentationSeenByStaffId" IS NOT NULL)
    ),
  -- A case cannot name somebody as the restricted party by tenant id and not
  -- by name; the name is what the operator reads and what a later reader can
  -- still make sense of if the Tenant row is retired.
  CONSTRAINT "ConfidentialCase_restricted_tenant_is_named"
    CHECK ("restrictedPartyTenantId" IS NULL OR "restrictedPartyName" IS NOT NULL)
);

CREATE UNIQUE INDEX "ConfidentialCase_lockChangeWorkOrderId_key"
  ON "ConfidentialCase"("lockChangeWorkOrderId");
CREATE INDEX "ConfidentialCase_leaseId_status_idx" ON "ConfidentialCase"("leaseId", "status");

ALTER TABLE "ConfidentialCase"
  ADD CONSTRAINT "ConfidentialCase_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ConfidentialCase"
  ADD CONSTRAINT "ConfidentialCase_restrictedPartyTenantId_fkey"
  FOREIGN KEY ("restrictedPartyTenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ConfidentialCase"
  ADD CONSTRAINT "ConfidentialCase_documentationSeenByStaffId_fkey"
  FOREIGN KEY ("documentationSeenByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ConfidentialCase"
  ADD CONSTRAINT "ConfidentialCase_openedByStaffId_fkey"
  FOREIGN KEY ("openedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ConfidentialCase"
  ADD CONSTRAINT "ConfidentialCase_lockChangeWorkOrderId_fkey"
  FOREIGN KEY ("lockChangeWorkOrderId") REFERENCES "WorkOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
