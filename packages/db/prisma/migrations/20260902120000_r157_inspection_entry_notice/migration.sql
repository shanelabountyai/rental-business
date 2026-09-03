-- R-157: inspections enter occupied units through the same entry-notice
-- chain work orders use. The walk gets a real visit window, the served
-- notice it relied on, and the logged override when staff went ahead
-- without one.

ALTER TABLE "Inspection"
  ADD COLUMN "scheduledEndAt" TIMESTAMP(3),
  ADD COLUMN "entryNoticeId" TEXT,
  ADD COLUMN "entryOverrideReason" TEXT,
  ADD COLUMN "entryOverriddenAt" TIMESTAMP(3);

-- RESTRICT, not SET NULL: Notice becomes append-only by trigger (R-161),
-- and a SET NULL cascade is an UPDATE the trigger would refuse, failing
-- the whole delete at runtime (R-032/R-034's twice-fixed bug).
ALTER TABLE "Inspection"
  ADD CONSTRAINT "Inspection_entryNoticeId_fkey"
  FOREIGN KEY ("entryNoticeId") REFERENCES "Notice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
