-- R-042: how this lease prorates a part month (PAY-08; D-12).
--
-- PER LEASE, not per property and not global, because leases genuinely
-- disagree - `prorateRent` has said so in a comment since R-035: "some
-- prorate on the actual days in the month, some on a flat 30-day month."
-- Which one applies is a term of the contract, so it belongs on the contract.
--
-- The difference is real money. A 9-day February move-in on $1,500 rent is
-- $482.14 on actual days and $450.00 on a 30-day month - and PAY-08 requires
-- the method to be visible on the tenant's ledger precisely because the two
-- answers look like each other's arithmetic error.
--
-- Defaults to ACTUAL: dividing by the days the month really has is what a
-- tenant checking against a calendar expects, and a 30-day convention is the
-- one that needs to be chosen deliberately.
CREATE TYPE "ProrationMethod" AS ENUM ('ACTUAL', 'BANKER30');

ALTER TABLE "Lease"
  ADD COLUMN "prorationMethod" "ProrationMethod" NOT NULL DEFAULT 'ACTUAL';
