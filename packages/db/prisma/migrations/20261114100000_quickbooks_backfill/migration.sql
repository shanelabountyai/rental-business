-- R-284 (PRD 09 Q11, D-400): the day the owner chose to push history from.
-- Null until chosen; the backfill plans pre-connect entries from that day on.
ALTER TABLE "QuickBooksConnection" ADD COLUMN "backfillFrom" DATE;

-- A fee the backfill reads for a payment settled before R-282b has no
-- webhook event behind it.
ALTER TABLE "StripeProcessingFee" ALTER COLUMN "stripeEventId" DROP NOT NULL;
