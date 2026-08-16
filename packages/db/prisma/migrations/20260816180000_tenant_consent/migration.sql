-- R-051b: TCPA consent capture (COMM-02, D-4).
--
-- ===========================================================================
-- STOP HAS BEEN BUILT SINCE R-030. CONSENT NEVER WAS.
--
-- `SmsOptOut` records that somebody asked us to stop, and `notify()` honours
-- it. Nothing has ever recorded that a tenant AGREED to be texted in the
-- first place - so the product's only gate was revocation of a permission it
-- never established. Under the TCPA that is the wrong way round, and the
-- damages are statutory and per-message.
--
-- WHAT THE BASIS MEANS, AND WHY IT IS NOT A BOOLEAN. "Consented" alone is
-- unfalsifiable six months later. What defends a claim is HOW consent was
-- obtained, so the basis is the point of the row:
--
--   EXPRESS_WRITTEN       - they were shown a disclosure and agreed to it.
--                           The only basis that covers PROMOTIONAL sends.
--   EXISTING_RELATIONSHIP - they gave us the number as part of a tenancy.
--                           Covers transactional messages about that tenancy
--                           (rent, maintenance, notices) and nothing else.
--   VERBAL                - staff recorded an agreement given on a call.
--                           Transactional only; weaker, and says so.
--   IMPORTED              - carried in from a prior system. Transactional
--                           only, and deliberately the weakest: it records
--                           that somebody ELSE claims consent exists.
--
-- Deliberately NOT a `hasConsented` boolean on Tenant. A boolean cannot say
-- when, how, what they were shown, or who recorded it - which is the entire
-- evidentiary content.
-- ===========================================================================

CREATE TYPE "ConsentChannel" AS ENUM ('SMS', 'EMAIL', 'VOICE');

CREATE TYPE "ConsentBasis" AS ENUM (
  'EXPRESS_WRITTEN',
  'EXISTING_RELATIONSHIP',
  'VERBAL',
  'IMPORTED'
);

CREATE TYPE "ConsentSource" AS ENUM (
  'STAFF_RECORDED',
  'PORTAL',
  'BACKFILL'
);

CREATE TABLE "TenantConsent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" "ConsentChannel" NOT NULL,
    "basis" "ConsentBasis" NOT NULL,
    "source" "ConsentSource" NOT NULL,
    -- The words they were actually shown, when they were shown any. Null for
    -- a basis that involves no disclosure (an existing relationship is a
    -- fact about how we got the number, not something anybody agreed to).
    "disclosureText" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByStaffId" TEXT,
    "note" TEXT,
    -- Withdrawal. Distinct from `SmsOptOut`, which is a fact about a PHONE
    -- NUMBER reported by a carrier; this is a fact about a PERSON and the
    -- permission they gave us. A number reassigned to somebody else must not
    -- carry the old tenant's consent, and a tenant who changes number must
    -- not lose it - which one table keyed on either alone cannot express.
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantConsent_pkey" PRIMARY KEY ("id")
);

-- EXPRESS_WRITTEN is the basis that unlocks promotional sending, so it is the
-- one that has to carry the words the tenant agreed to. Without them the
-- record claims the strongest form of consent and cannot show what was
-- consented to, which is worse than claiming a weaker one honestly.
ALTER TABLE "TenantConsent"
  ADD CONSTRAINT "TenantConsent_express_needs_disclosure"
  CHECK ("basis" <> 'EXPRESS_WRITTEN' OR "disclosureText" IS NOT NULL);

CREATE INDEX "TenantConsent_tenantId_channel_idx"
  ON "TenantConsent" ("tenantId", "channel");

ALTER TABLE "TenantConsent" ADD CONSTRAINT "TenantConsent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TenantConsent" ADD CONSTRAINT "TenantConsent_recordedByStaffId_fkey"
  FOREIGN KEY ("recordedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- APPEND-ONLY EXCEPT FOR WITHDRAWAL, the same shape R-051 gave NoticeDelivery
-- and for the same reason: a consent record that can be edited afterwards is
-- not evidence of anything, and TCPA damages are statutory and per-message.
-- The one permitted change is `revokedAt` going from null to a timestamp,
-- with an optional reason recorded in the same statement.
--
-- NOTE FOR A LATER ITEM: `SmsOptOut` carries the same evidentiary weight and
-- has no such guard. Left alone here rather than widened silently - it is
-- named in this item's PROGRESS entry as a follow-up.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenant_consent_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'TenantConsent is append-only; DELETE is not permitted. Withdrawal is a revokedAt timestamp.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION
      'TenantConsent.revokedAt is write-once; consent already withdrawn. Re-consenting is a new row.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."revokedAt" IS NULL THEN
    RAISE EXCEPTION
      'TenantConsent is append-only; the only permitted update is withdrawing consent.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Everything except the two withdrawal columns must be byte-identical.
  IF (to_jsonb(NEW) - 'revokedAt' - 'revokeReason')
     IS DISTINCT FROM (to_jsonb(OLD) - 'revokedAt' - 'revokeReason') THEN
    RAISE EXCEPTION
      'TenantConsent: only revokedAt and revokeReason may change on a consent record.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TenantConsent_append_only"
  BEFORE UPDATE OR DELETE ON "TenantConsent"
  FOR EACH ROW EXECUTE FUNCTION tenant_consent_guard();

CREATE TRIGGER "TenantConsent_no_truncate"
  BEFORE TRUNCATE ON "TenantConsent"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- BACKFILL — the owner's decision, recorded rather than assumed.
--
-- Every tenant already on file gave us their number as part of a tenancy.
-- Gating on consent without this would silently switch off rent reminders,
-- maintenance updates and notice delivery for the entire existing roster the
-- moment it shipped, until somebody worked through them by hand - which is a
-- worse outcome than the risk it removes, for messages that are transactional
-- by definition.
--
-- So: EXISTING_RELATIONSHIP, source BACKFILL, with a note that says exactly
-- what this row is and is not. It does NOT claim anybody agreed to anything -
-- it records the basis honestly, which is the whole point of storing a basis
-- rather than a boolean. Promotional sending remains barred to all of them,
-- because only EXPRESS_WRITTEN unlocks that.
-- ---------------------------------------------------------------------------
INSERT INTO "TenantConsent" ("id", "tenantId", "channel", "basis", "source", "note", "recordedAt", "createdAt")
SELECT
  gen_random_uuid()::text,
  t."id",
  'SMS',
  'EXISTING_RELATIONSHIP',
  'BACKFILL',
  'Backfilled at R-051b. The tenant provided this number as part of a tenancy; no disclosure was shown and nobody clicked anything. Transactional messages only - promotional sending requires EXPRESS_WRITTEN.',
  NOW(),
  NOW()
FROM "Tenant" t
WHERE t."phone" IS NOT NULL
  AND t."active" = true;
