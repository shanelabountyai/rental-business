-- R-094 (LEASE-08, PROP-03): smart-lockbox self-showings.
--
-- ==========================================================================
-- WHAT AN UNACCOMPANIED-ENTRY CODE ACTUALLY IS. Every other access code in
-- this product is handed to somebody who already has a relationship with the
-- property: a vendor with a dispatched job, a tenant who has signed a lease.
-- This one is handed to a STRANGER who saw a listing, so that they can walk
-- into a house on their own with nobody there.
--
-- Three columns carry the whole of that difference:
--
--   * `ShowingAccess.identityCheckId` is NOT NULL. A code cannot exist
--     without the check that bought it, at the database, not by manners - so
--     there is no code path, present or future, that issues one to somebody
--     unverified.
--   * `validFrom` / `validTo` are the real control, and they are NOT the
--     link's lifetime. The link may be opened the day before to get the
--     identity check done; the code answers only inside the window around
--     the booked slot.
--   * `revokedAt` is the instant kill. Kept as a column on a row that
--     survives rather than a delete: "was that code live at 3pm on Tuesday"
--     is answerable only from a row that outlived being killed - the same
--     call LeaseHold.liftedAt makes.
--
-- NO PHOTO ID IS STORED, ANYWHERE. R-091's D-108 settled the general form of
-- this: a `Document` row is readable by every role holding `document.read`,
-- which is the manager, the maintenance tech and the read-only partner, so
-- uploading a stranger's driving licence to prove they are who they say
-- would put it in front of the person who comes to fix the boiler - and
-- would keep it for ever. What is recorded is that a check of a stated class
-- was run, by which provider, with what reference, on what date, and the NAME
-- the document gave. The name, because "the ID said someone else" is the one
-- branch this whole feature exists to catch, and a decision nobody can
-- reconstruct is not a decision.
-- ==========================================================================

CREATE TYPE "SmartLockProvider" AS ENUM ('SIMULATED');

-- ONE LOCK PER UNIT, and its absence is what makes self-showings opt-in. A
-- unit with no lock row books exactly the way R-064 already books: escorted,
-- with a staff Task. Nothing about existing units changes.
CREATE TABLE "SmartLock" (
  "id"          TEXT NOT NULL,
  "unitId"      TEXT NOT NULL,
  "provider"    "SmartLockProvider" NOT NULL DEFAULT 'SIMULATED',
  -- The device's own id at the provider. Never invented by us (D-27).
  "externalId"  TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SmartLock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SmartLock_unitId_key" ON "SmartLock"("unitId");
CREATE UNIQUE INDEX "SmartLock_provider_externalId_key" ON "SmartLock"("provider", "externalId");

ALTER TABLE "SmartLock"
  ADD CONSTRAINT "SmartLock_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- NAME_MISMATCH is its own result rather than a flavour of FAILED. They mean
-- opposite things operationally: a failed check is a photo that would not
-- read and the prospect should try again, while a mismatch is a document in
-- somebody else's name and is the one outcome a person should look at.
CREATE TYPE "IdentityCheckResult" AS ENUM ('VERIFIED', 'NAME_MISMATCH', 'FAILED');

CREATE TABLE "IdentityCheck" (
  "id"           TEXT NOT NULL,
  "prospectId"   TEXT NOT NULL,
  "provider"     TEXT NOT NULL,
  -- The provider's own reference for the check. What a later question is
  -- taken back to the provider with, since we hold none of the evidence.
  "reference"    TEXT NOT NULL,
  "result"       "IdentityCheckResult" NOT NULL,
  -- The name the DOCUMENT gave, as the provider read it. No date of birth,
  -- no document number, no image, no expiry - none of which any decision
  -- here reads, and each of which would be a thing to lose.
  "documentName" TEXT NOT NULL,
  "checkedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "IdentityCheck_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IdentityCheck_prospectId_checkedAt_idx"
  ON "IdentityCheck"("prospectId", "checkedAt");

ALTER TABLE "IdentityCheck"
  ADD CONSTRAINT "IdentityCheck_prospectId_fkey"
  FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ShowingAccess" (
  "id"              TEXT NOT NULL,
  "showingId"       TEXT NOT NULL,
  "smartLockId"     TEXT NOT NULL,
  -- NOT NULL: no code without the check that bought it. See the header.
  "identityCheckId" TEXT NOT NULL,
  "providerRef"     TEXT NOT NULL,
  -- Sealed the same way `AccessCode.sealedCode` is (R-005), by the same box.
  -- The prospect is shown it through their own link inside the window; staff
  -- reading it is `accesscode.reveal`, which is privileged and audited.
  "sealedCode"      TEXT NOT NULL,
  "validFrom"       TIMESTAMP(3) NOT NULL,
  "validTo"         TIMESTAMP(3) NOT NULL,
  "issuedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"       TIMESTAMP(3),
  "revokedReason"   TEXT,
  "revokedByStaffId" TEXT,

  CONSTRAINT "ShowingAccess_pkey" PRIMARY KEY ("id"),
  -- A window that ends before it starts is not a window.
  CONSTRAINT "ShowingAccess_window_is_ordered" CHECK ("validTo" > "validFrom"),
  -- A kill is a claim somebody made. Unreasoned, it is indistinguishable
  -- from a mis-click, and "why was this code pulled" is what a prospect
  -- standing at a locked door will ask.
  CONSTRAINT "ShowingAccess_revoked_with_reason"
    CHECK (("revokedAt" IS NULL) = ("revokedReason" IS NULL))
);
CREATE UNIQUE INDEX "ShowingAccess_showingId_key" ON "ShowingAccess"("showingId");
CREATE UNIQUE INDEX "ShowingAccess_identityCheckId_key" ON "ShowingAccess"("identityCheckId");
CREATE INDEX "ShowingAccess_smartLockId_validFrom_idx"
  ON "ShowingAccess"("smartLockId", "validFrom");

ALTER TABLE "ShowingAccess"
  ADD CONSTRAINT "ShowingAccess_showingId_fkey"
  FOREIGN KEY ("showingId") REFERENCES "Showing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowingAccess"
  ADD CONSTRAINT "ShowingAccess_smartLockId_fkey"
  FOREIGN KEY ("smartLockId") REFERENCES "SmartLock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowingAccess"
  ADD CONSTRAINT "ShowingAccess_identityCheckId_fkey"
  FOREIGN KEY ("identityCheckId") REFERENCES "IdentityCheck"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShowingAccess"
  ADD CONSTRAINT "ShowingAccess_revokedByStaffId_fkey"
  FOREIGN KEY ("revokedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DENIED is as much of the entry log as UNLOCKED. A run of refusals at a
-- door at 11pm is the thing somebody wants to see, and a log that recorded
-- only successes would show nothing at all on the night it mattered.
CREATE TYPE "LockEventKind" AS ENUM ('UNLOCKED', 'DENIED');

CREATE TABLE "LockEvent" (
  "id"              TEXT NOT NULL,
  "smartLockId"     TEXT NOT NULL,
  -- Null for an event the device reports that no code of ours explains - a
  -- key, a staff member's own app, a code issued before this system knew
  -- about the lock. Kept rather than dropped: an unexplained entry is
  -- precisely the one worth having a record of.
  "showingAccessId" TEXT,
  "kind"            "LockEventKind" NOT NULL,
  "occurredAt"      TIMESTAMP(3) NOT NULL,
  -- The device's own event id. The uniqueness below is what makes syncing
  -- idempotent, so a sync run twice does not double the log.
  "providerRef"     TEXT NOT NULL,
  "actorLabel"      TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LockEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LockEvent_smartLockId_providerRef_key"
  ON "LockEvent"("smartLockId", "providerRef");
CREATE INDEX "LockEvent_smartLockId_occurredAt_idx"
  ON "LockEvent"("smartLockId", "occurredAt");

ALTER TABLE "LockEvent"
  ADD CONSTRAINT "LockEvent_smartLockId_fkey"
  FOREIGN KEY ("smartLockId") REFERENCES "SmartLock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LockEvent"
  ADD CONSTRAINT "LockEvent_showingAccessId_fkey"
  FOREIGN KEY ("showingAccessId") REFERENCES "ShowingAccess"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The prospect's link to the door. MULTI-USE until it expires, unlike
-- SHOWING_BOOKING which is burned on the one slot it books: this one is
-- opened at least twice by design - once to get the identity check done,
-- once standing at the door - and a link that died on first open would
-- strand somebody outside a house.
--
-- Its lifetime is NOT the code's. The code answers only inside `validFrom`/
-- `validTo`; the link merely shows a page that explains which of those two
-- states you are in.
ALTER TYPE "AuthTokenPurpose" ADD VALUE 'SHOWING_ACCESS';
