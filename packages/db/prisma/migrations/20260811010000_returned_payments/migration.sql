-- R-039: returned payments and the NSF fee (PAY-02; D-4, D-12).
--
-- An ACH debit gives "instant provisional access" and takes up to four
-- business days to confirm. PAY-02 is explicit about the failure that
-- creates: when the return arrives, "no downstream action that was triggered
-- by the provisional payment remains incorrectly in effect."
--
-- The fee is jurisdiction configuration like every other statutory number
-- (D-4). Texas caps a returned-check fee at 30 USD (Tex. Bus. & Com. Code
-- §3.506); other states differ, and several bar one entirely - which is what
-- `nsfFeePermitted` is for. Core computes and clamps it (D-12); Stripe is
-- handed a finished amount.
ALTER TABLE "JurisdictionRule"
  ADD COLUMN "nsfFeePermitted" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "JurisdictionRule"
  ADD COLUMN "nsfFeeMaxCents" INTEGER;

-- "What reversed this entry" as an indexed question. Partial, because the
-- overwhelming majority of ledger rows are not reversals and an unfiltered
-- index over a mostly-NULL column earns nothing.
CREATE INDEX "LedgerEntry_reverses"
  ON "LedgerEntry" ("reversesId")
  WHERE "reversesId" IS NOT NULL;
