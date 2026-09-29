-- LEGAL-02: what an FCRA adverse-action notice must disclose about a credit
-- score (15 U.S.C. § 1681m(a)(2)), as the provider reported it.
ALTER TABLE "ScreeningReport" ADD COLUMN "creditScoreRangeLow" INTEGER;
ALTER TABLE "ScreeningReport" ADD COLUMN "creditScoreRangeHigh" INTEGER;
ALTER TABLE "ScreeningReport" ADD COLUMN "creditScoreFactors" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ScreeningReport" ADD COLUMN "creditScoreOn" DATE;
ALTER TABLE "ScreeningReport" ADD COLUMN "creditScoreSource" TEXT;
