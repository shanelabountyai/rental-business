-- R-041: how the deposit is held, not just how much (PAY-07; D-4).
--
-- `depositCents` alone cannot distinguish the three cases that matter, and
-- they are genuinely different at move-out:
--
--   CASH        - the landlord holds the tenant's money on trust. A
--                 LIABILITY, returnable minus what can lawfully be proved,
--                 and in several states it must sit in a separate account
--                 and earn interest.
--   SURETY_BOND - the tenant paid a premium to a third party and the
--                 landlord holds NOTHING. Nothing to escrow, no interest, and
--                 nothing to return.
--   NONE        - no deposit of any kind.
--
-- Recording a surety bond as "a cash deposit of $0" would be true and
-- useless. The failure it prevents is at move-out, in both directions: a
-- tenant chased to collect a refund nobody owes them, or an owner believing
-- they hold money that was never taken.
--
-- Defaults to CASH because that is what every existing lease is: the column
-- did not exist, so nobody could have chosen otherwise, and every lease
-- carrying a non-zero depositCents today is a cash deposit by construction.
CREATE TYPE "DepositArrangement" AS ENUM ('CASH', 'SURETY_BOND', 'NONE');

ALTER TABLE "Lease"
  ADD COLUMN "depositArrangement" "DepositArrangement" NOT NULL DEFAULT 'CASH';

-- Money cannot be held under an arrangement that holds none. Enforced here
-- rather than only in the form, because the same contradiction reached by any
-- other route - an import, a fixture, a later screen - produces exactly the
-- move-out confusion above.
ALTER TABLE "Lease" ADD CONSTRAINT "Lease_deposit_arrangement_consistent"
  CHECK ("depositArrangement" = 'CASH' OR "depositCents" = 0);
