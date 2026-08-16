-- R-051: notice delivery proof (COMM-02, D-4).
--
-- ===========================================================================
-- WHY A CHILD TABLE AND NOT THE COLUMNS THAT ALREADY EXIST.
--
-- `Notice` has carried `serviceMethod` / `servedAt` / `proofDocumentId` /
-- `trackingNumber` since R-002, and nothing ever wrote the last two. Those
-- columns model ONE service event, and service is frequently more than one:
-- several states require a notice to vacate be BOTH posted on the door AND
-- mailed, and each half has its own separate proof - a photograph for the
-- posting, a tracking number and a receipt for the mailing. One column pair
-- cannot hold two proofs, so an owner who did the lawful thing could not
-- record that they had.
--
-- `Notice.serviceMethod`/`servedAt` are kept as the FIRST service, so every
-- existing reader (the entry-notice flow, its e2e specs) keeps working and
-- list screens can sort without a join. `NoticeDelivery` is the real record:
-- one row per service event, each carrying its own proof.
-- ===========================================================================

-- WHICH METHODS A STATE ACTUALLY ALLOWS, per notice type (D-4). Nothing in
-- this product knew this before: `NoticeServiceMethod` is a list of mechanics
-- we can record, never a statement that any of them is lawful where you are.
--
-- JSON rather than columns because notice TYPES are themselves free-form
-- configuration (see Notice.type's own comment) - a state that invents a new
-- notice must not require a migration, and neither must one that changes
-- which methods serve it. Shape: { "NOTICE_TO_VACATE": ["PERSONAL", ...] }.
-- Core validates it on write; see packages/core/jurisdiction/validate.ts.
ALTER TABLE "JurisdictionRule" ADD COLUMN "noticeServiceMethods" JSONB;

CREATE TABLE "NoticeDelivery" (
    "id" TEXT NOT NULL,
    "noticeId" TEXT NOT NULL,
    "method" "NoticeServiceMethod" NOT NULL,
    "servedAt" TIMESTAMP(3) NOT NULL,
    "servedByStaffId" TEXT,
    -- The photograph of the posted notice, or the certified-mail receipt.
    "proofDocumentId" TEXT,
    "trackingNumber" TEXT,
    "carrier" TEXT,
    -- PORTAL service only: when the tenant actually opened it. Write-once,
    -- enforced by trigger below - see the note there.
    "readAt" TIMESTAMP(3),
    -- Whether the jurisdiction permits this method for this notice type.
    -- NULL means NO RULE IS CONFIGURED, which is deliberately not `false`:
    -- the same call R-044's `graceUnknown` makes, because "we do not know
    -- what this state allows" and "this state forbids it" are different
    -- facts and only one of them is an accusation.
    "permittedByJurisdiction" BOOLEAN,
    "jurisdictionRuleId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoticeDelivery_pkey" PRIMARY KEY ("id")
);

-- The enum value is named POSTED_WITH_PHOTO, so a row claiming it without a
-- photograph is not a weaker record - it is a false one. Enforced here rather
-- than in the action, because this is the evidence an eviction turns on.
ALTER TABLE "NoticeDelivery"
  ADD CONSTRAINT "NoticeDelivery_posted_needs_photo"
  CHECK ("method" <> 'POSTED_WITH_PHOTO' OR "proofDocumentId" IS NOT NULL);

-- Same reasoning: certified mail whose article number nobody wrote down
-- cannot be tracked, produces no delivery scan, and proves nothing.
ALTER TABLE "NoticeDelivery"
  ADD CONSTRAINT "NoticeDelivery_certified_needs_tracking"
  CHECK ("method" <> 'CERTIFIED_MAIL' OR "trackingNumber" IS NOT NULL);

-- A read receipt is only meaningful for service that happened in the portal.
ALTER TABLE "NoticeDelivery"
  ADD CONSTRAINT "NoticeDelivery_read_receipt_is_portal_only"
  CHECK ("readAt" IS NULL OR "method" = 'PORTAL');

CREATE INDEX "NoticeDelivery_noticeId_idx" ON "NoticeDelivery" ("noticeId");
CREATE INDEX "NoticeDelivery_servedAt_idx" ON "NoticeDelivery" ("servedAt");

-- RESTRICT on every key, like every other evidence-trail foreign key in this
-- schema: the photograph IS the proof of service, and deleting it would
-- leave a served notice whose record can no longer be defended.
ALTER TABLE "NoticeDelivery" ADD CONSTRAINT "NoticeDelivery_noticeId_fkey"
  FOREIGN KEY ("noticeId") REFERENCES "Notice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NoticeDelivery" ADD CONSTRAINT "NoticeDelivery_servedByStaffId_fkey"
  FOREIGN KEY ("servedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NoticeDelivery" ADD CONSTRAINT "NoticeDelivery_proofDocumentId_fkey"
  FOREIGN KEY ("proofDocumentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NoticeDelivery" ADD CONSTRAINT "NoticeDelivery_jurisdictionRuleId_fkey"
  FOREIGN KEY ("jurisdictionRuleId") REFERENCES "JurisdictionRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- APPEND-ONLY, WITH EXACTLY ONE EXCEPTION.
--
-- A service event is a fact about something that already happened, so the
-- same reasoning that makes LedgerEntry and AuditLog append-only applies: if
-- "when did we serve it, and how" can be edited afterwards, it is not proof
-- of anything. A correction is a new row.
--
-- The exception is `readAt`, which cannot be known at insert time - the
-- tenant opens the notice later, and that opening is itself the proof that
-- PORTAL service reached them. So the trigger allows exactly one transition,
-- NULL -> a timestamp, and nothing else on the row may move with it. A second
-- view does not overwrite the first: the evidence is when they FIRST read it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notice_delivery_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'NoticeDelivery is append-only; DELETE is not permitted. A correction is a new row.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."readAt" IS NOT NULL THEN
    RAISE EXCEPTION
      'NoticeDelivery.readAt is write-once; the proof is when the tenant FIRST read it.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."readAt" IS NULL THEN
    RAISE EXCEPTION
      'NoticeDelivery is append-only; the only permitted update is setting readAt.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Everything except readAt must be byte-identical. Comparing the rows as
  -- jsonb minus that one key is shorter than naming every column and, more
  -- to the point, cannot silently miss a column added later.
  IF (to_jsonb(NEW) - 'readAt') IS DISTINCT FROM (to_jsonb(OLD) - 'readAt') THEN
    RAISE EXCEPTION
      'NoticeDelivery: readAt is the only field that may ever change on a service record.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "NoticeDelivery_append_only"
  BEFORE UPDATE OR DELETE ON "NoticeDelivery"
  FOR EACH ROW EXECUTE FUNCTION notice_delivery_guard();

-- Row-level triggers do not fire on TRUNCATE, so the statement-level guard is
-- what makes the protection wider than a single command.
CREATE TRIGGER "NoticeDelivery_no_truncate"
  BEFORE TRUNCATE ON "NoticeDelivery"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- BACKFILL. Every notice already served carries its method and timestamp on
-- the Notice row itself; those are real service events and must appear in the
-- new record, or the history starts today and the evidence trail has a hole
-- exactly where the product's existing entry notices live.
-- ---------------------------------------------------------------------------
INSERT INTO "NoticeDelivery" (
  "id", "noticeId", "method", "servedAt", "servedByStaffId",
  "proofDocumentId", "trackingNumber", "jurisdictionRuleId", "note", "createdAt"
)
SELECT
  gen_random_uuid()::text,
  n."id",
  n."serviceMethod",
  n."servedAt",
  n."servedByStaffId",
  n."proofDocumentId",
  n."trackingNumber",
  n."jurisdictionRuleId",
  'Backfilled at R-051 from the Notice row this service was originally recorded on.',
  n."createdAt"
FROM "Notice" n
WHERE n."servedAt" IS NOT NULL
  AND n."serviceMethod" IS NOT NULL
  -- The CHECK constraints above are real: a backfilled row that cannot
  -- satisfy them is a pre-existing record that was never proof in the first
  -- place, and inventing a photograph for it would be worse than leaving it
  -- on the Notice row where it already sits.
  AND (n."serviceMethod" <> 'POSTED_WITH_PHOTO' OR n."proofDocumentId" IS NOT NULL)
  AND (n."serviceMethod" <> 'CERTIFIED_MAIL' OR n."trackingNumber" IS NOT NULL);
