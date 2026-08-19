-- R-070: pre-move-out walkthrough right (INSP-02, D-4).
-- Both nullable, no default: null means "not reviewed for this jurisdiction",
-- never "no right granted" - the same posture sourceOfIncomeProtected (R-056)
-- already takes on this same table.

ALTER TABLE "JurisdictionRule"
  ADD COLUMN "preMoveOutWalkthroughRequired" BOOLEAN,
  ADD COLUMN "preMoveOutWalkthroughDaysBefore" INTEGER;
