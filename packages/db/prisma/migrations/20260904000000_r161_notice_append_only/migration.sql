-- ---------------------------------------------------------------------------
-- Notice joins LedgerEntry, AuditLog, Message and Notification as
-- append-only (flagged in R-051, carried through R-052, mutable ever
-- since - R-161, review finding 13).
--
-- A served notice is evidence: "we told this tenant to cure or vacate, on
-- this day, worded this way" is exactly what a deposit dispute or an
-- eviction turns on, and a row that can be edited afterwards proves
-- nothing. A correction is a superseding Notice linked to the one it
-- replaces (see `Notice.leaseId`'s neighbours for the shape - the pattern
-- is the same `reversesId`-style self-reference LedgerEntry already uses),
-- never an edit to the served original.
--
-- Unlike those four tables, Notice is not insert-and-never-touch: three
-- existing flows attach a fact to a notice sometime after it is generated,
-- and application code already treats every one of them as write-once
-- (NULL -> a value, never overwritten):
--   - `generateNoticePdf` sets documentId once the PDF is rendered and
--     archived, and already refuses to run a second time.
--   - `recordService` (COMM-02) sets serviceMethod/servedAt/
--     servedByStaffId/proofDocumentId/trackingNumber from the FIRST
--     `NoticeDelivery`, and already guards with `if (!notice.servedAt)` -
--     a second service event does not rewrite the first.
--   - `attachNoticeToCase` sets evictionCaseId once a served notice is
--     filed under a case, and already refuses a notice already filed.
--
-- The trigger is the backstop for all three: each of those seven columns
-- may move NULL -> a value exactly once, and nothing else on the row may
-- ever change. DELETE is refused outright, same as the other four tables.
--
-- Consequence, already true of AuditLog/Notification and worked around the
-- same way: Notice.leaseId, .applicantId, .violationCaseId and
-- .evictionCaseId are onDelete: Restrict, so a lease/case with a Notice
-- filed against it cannot be hard-deleted. Deactivate or leave it, as
-- every other append-only remnant already does in this suite.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION notice_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Notice is append-only; DELETE is not permitted. A correction is a superseding Notice, never an edit.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."documentId" IS NOT NULL AND NEW."documentId" IS DISTINCT FROM OLD."documentId" THEN
    RAISE EXCEPTION
      'Notice.documentId is write-once; the archived PDF is the one that was actually served.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."serviceMethod" IS NOT NULL AND NEW."serviceMethod" IS DISTINCT FROM OLD."serviceMethod" THEN
    RAISE EXCEPTION
      'Notice.serviceMethod is write-once; the evidence is the FIRST service, not the latest.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."servedAt" IS NOT NULL AND NEW."servedAt" IS DISTINCT FROM OLD."servedAt" THEN
    RAISE EXCEPTION
      'Notice.servedAt is write-once; the evidence is the FIRST service, not the latest.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."servedByStaffId" IS NOT NULL AND NEW."servedByStaffId" IS DISTINCT FROM OLD."servedByStaffId" THEN
    RAISE EXCEPTION
      'Notice.servedByStaffId is write-once; the evidence is the FIRST service, not the latest.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."proofDocumentId" IS NOT NULL AND NEW."proofDocumentId" IS DISTINCT FROM OLD."proofDocumentId" THEN
    RAISE EXCEPTION
      'Notice.proofDocumentId is write-once; the evidence is the FIRST service, not the latest.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."trackingNumber" IS NOT NULL AND NEW."trackingNumber" IS DISTINCT FROM OLD."trackingNumber" THEN
    RAISE EXCEPTION
      'Notice.trackingNumber is write-once; the evidence is the FIRST service, not the latest.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."evictionCaseId" IS NOT NULL AND NEW."evictionCaseId" IS DISTINCT FROM OLD."evictionCaseId" THEN
    RAISE EXCEPTION
      'Notice.evictionCaseId is write-once; a notice is filed under one case, never moved.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Everything except the seven write-once columns above must be
  -- byte-identical. Diffing as jsonb minus that set is shorter than naming
  -- every remaining column and, more to the point, cannot silently miss a
  -- column added later.
  IF (to_jsonb(NEW) - ARRAY[
        'documentId', 'serviceMethod', 'servedAt', 'servedByStaffId',
        'proofDocumentId', 'trackingNumber', 'evictionCaseId'
      ])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'documentId', 'serviceMethod', 'servedAt', 'servedByStaffId',
        'proofDocumentId', 'trackingNumber', 'evictionCaseId'
      ])
  THEN
    RAISE EXCEPTION
      'Notice is append-only; only documentId, serviceMethod, servedAt, servedByStaffId, proofDocumentId, trackingNumber and evictionCaseId may ever be set, and each exactly once.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Notice_append_only"
  BEFORE UPDATE OR DELETE ON "Notice"
  FOR EACH ROW EXECUTE FUNCTION notice_guard();

-- Row-level triggers do not fire on TRUNCATE, so the statement-level guard
-- (already defined for LedgerEntry/AuditLog/Message/Notification) is what
-- makes the protection wider than a single command.
CREATE TRIGGER "Notice_no_truncate"
  BEFORE TRUNCATE ON "Notice"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
