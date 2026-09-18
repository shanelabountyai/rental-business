-- R-227: a NOTICE_SERVED hold names the notice it was placed for, so the
-- nightly late-fee job can lift it when that notice is cured, its cure period
-- runs out, or its case closes. Nullable: every other hold type, and a
-- NOTICE_SERVED hold placed by hand for a notice served outside the product,
-- has no notice here.
ALTER TABLE "LeaseHold" ADD COLUMN "noticeId" TEXT;

ALTER TABLE "LeaseHold"
  ADD CONSTRAINT "LeaseHold_noticeId_fkey"
  FOREIGN KEY ("noticeId") REFERENCES "Notice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The holds R-213 already placed. Its serve action snapshotted the notice id
-- into the placement's audit row (`after.noticeId`), so the link is recovered
-- from the record rather than guessed from dates. A hold with no such row was
-- placed by hand and stays unlinked.
UPDATE "LeaseHold" h
SET "noticeId" = a."after"->>'noticeId'
FROM "AuditLog" a
WHERE h."type" = 'NOTICE_SERVED'
  AND a."action" = 'lease.hold_placed'
  AND a."after"->>'holdId' = h."id"
  AND a."after"->>'noticeId' IS NOT NULL
  AND EXISTS (SELECT 1 FROM "Notice" n WHERE n."id" = a."after"->>'noticeId');
