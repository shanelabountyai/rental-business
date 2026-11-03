-- R-300a: when the org froze (the D-325 window counts from it) and, once
-- scheduled, when R-300b may purge it.
ALTER TABLE "Organization" ADD COLUMN "frozenAt" TIMESTAMP(3), ADD COLUMN "offboardAt" TIMESTAMP(3);

ALTER TABLE "Organization" ADD CONSTRAINT "Organization_frozenAt_check"
  CHECK (("status" = 'FROZEN') = ("frozenAt" IS NOT NULL) OR "status" = 'OFFBOARDED');
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_offboardAt_check"
  CHECK ("offboardAt" IS NULL OR "status" IN ('FROZEN', 'OFFBOARDED'));
