-- LEGAL-01: the date of the most recent eviction / criminal record, so the
-- lookback window is checked against a date rather than asserted.
ALTER TABLE "ScreeningReport" ADD COLUMN "evictionRecordOn" DATE;
ALTER TABLE "ScreeningReport" ADD COLUMN "criminalRecordOn" DATE;
