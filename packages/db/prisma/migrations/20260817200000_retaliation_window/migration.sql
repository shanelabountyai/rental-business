-- R-055: the retaliation-claim guard (RISK-06; D-4).
--
-- Many states presume retaliation when an owner raises rent, non-renews or
-- serves notice within a window after a tenant complaint or exercise of
-- legal rights - commonly around six months, but the exact length is a
-- statute, not a constant, so it lives here alongside every other number
-- this product refuses to hardcode.
--
-- NULLABLE, and null means "not configured" - never "no window applies".
-- Consuming code (packages/core/leases/retaliation.ts) treats a null window
-- the same way `graceUnknown`/`servicePermitted() === null` already do
-- elsewhere: the check is skipped rather than guessed at, because a made-up
-- number would be worse than the honest gap it would be covering for.
ALTER TABLE "JurisdictionRule" ADD COLUMN "retaliationWindowDays" INTEGER;

-- Same shape as every other day-count column here (Lease_nsfFeeCents_nonnegative).
ALTER TABLE "JurisdictionRule" ADD CONSTRAINT "JurisdictionRule_retaliationWindowDays_nonnegative"
  CHECK ("retaliationWindowDays" IS NULL OR "retaliationWindowDays" >= 0);
