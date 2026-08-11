-- R-040: late-fee assessment (PAY-04; D-4, D-12).
--
-- `lateFeeFor()` returns the CUMULATIVE fee owed as of a date, not the
-- increment since yesterday - which is right for a DAILY or FLAT_PLUS_DAILY
-- rule and is a trap for anything that assesses on a schedule. Charging the
-- cumulative figure every night would compound a $10/day fee into $10, $20,
-- $30 on consecutive days for a total of $60 by day three.
--
-- So a late fee is charged as a DELTA against what has already been assessed
-- on the rent charge it belongs to, and that requires knowing which rent
-- charge each fee was assessed on. Hence this column: it is what makes "how
-- much late fee has this particular overdue rent already attracted"
-- answerable, and it is also the spine of PAY-04's waiver-pattern report.
ALTER TABLE "Charge" ADD COLUMN "assessedOnChargeId" TEXT;

ALTER TABLE "Charge"
  ADD CONSTRAINT "Charge_assessedOnChargeId_fkey"
  FOREIGN KEY ("assessedOnChargeId") REFERENCES "Charge"("id")
  -- RESTRICT, not CASCADE: a rent charge that has attracted a late fee is a
  -- charge with money hanging off it, and deleting it out from under the fee
  -- would leave a fee nobody can explain. Charges are corrected by waiving or
  -- reversing, never by deletion.
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The assessment query's own index: "what has already been charged against
-- this rent charge". Partial, because only fees carry the column.
CREATE INDEX "Charge_assessed_on"
  ON "Charge" ("assessedOnChargeId")
  WHERE "assessedOnChargeId" IS NOT NULL;
