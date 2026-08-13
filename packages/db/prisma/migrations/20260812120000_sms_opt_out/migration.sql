-- R-040e: carrier SMS opt-out (NOTIF-01, COMM-02; D-38).
--
-- KEYED BY PHONE NUMBER, NOT BY TENANT, and that is the whole design.
-- A carrier-level STOP blocks a NUMBER against our sending number. It is not
-- a preference held by a person: it survives the tenant moving out, it
-- applies to whoever holds the number next, and it cannot be overridden by
-- anything in NotificationPreference - which is exactly why it is a separate
-- table rather than another row there. NotificationPreference is a tenant's
-- choice about a category; this is a carrier's fact about a number.
--
-- The distinction matters most for the categories a tenant is NOT allowed to
-- switch off. `entry_notice` is in LOCKED_CATEGORIES because it is legally
-- significant, and the product refuses to let anyone disable it - but a STOP
-- overrides us entirely, and until this table existed the notification log
-- would still have recorded those notices as SENT. A delivery record that can
-- be silently false is the worst defect an evidence trail can have.

CREATE TYPE "SmsOptOutSource" AS ENUM ('INBOUND_KEYWORD', 'CARRIER_CALLBACK');

CREATE TABLE "SmsOptOut" (
  "id"         TEXT NOT NULL,
  -- E.164, normalised by the same helper every other phone column uses.
  "phone"      TEXT NOT NULL,
  "optedOutAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source"     "SmsOptOutSource" NOT NULL,
  -- The word they actually sent, or the provider error code that told us.
  -- Kept because "why do you think I opted out" is a question somebody will
  -- eventually ask, and "STOP" and "21610" are different answers.
  "reason"     TEXT,
  -- Set when START arrives. Kept rather than deleting the row: a number that
  -- has opted out and back in twice is a pattern worth being able to see,
  -- and the audit trail alone would not show the current state.
  "revokedAt"  TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SmsOptOut_pkey" PRIMARY KEY ("id")
);

-- One row per number, updated in place when it opts out again. A history of
-- every toggle lives in AuditLog, which is append-only and is the right place
-- for it; this table answers "is this number blocked right now", and that
-- question has exactly one answer per number.
CREATE UNIQUE INDEX "SmsOptOut_phone_key" ON "SmsOptOut"("phone");

-- The send path asks this on every SMS: partial, because a revoked opt-out is
-- precisely the row it never wants.
CREATE INDEX "SmsOptOut_active" ON "SmsOptOut"("phone") WHERE "revokedAt" IS NULL;
