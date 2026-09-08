-- R-182 (review finding 14): how a jurisdiction counts to thirty.
--
-- `dayCountBasis` is NULLABLE WITH NO DEFAULT, deliberately. A default of
-- CALENDAR would backfill every existing row with the assertion "counsel
-- confirmed this state counts calendar days", which nobody has said about any
-- of them - the same three-valued posture `sourceOfIncomeProtected` and
-- `acceptanceWaivesNotice` already take on this table. `statutoryDeadline`
-- reads null as calendar, so no deadline already running moves (D-12); the
-- gap becomes visible on the coverage screen instead.
--
-- `observedHolidays` DOES default to an empty array, because "this state
-- observes no holidays we have recorded" is not a legal claim - it is the
-- absence of one, and a CALENDAR state never reads it at all.

CREATE TYPE "DayCountBasis" AS ENUM ('CALENDAR', 'CALENDAR_ROLL_FORWARD', 'BUSINESS');

ALTER TABLE "JurisdictionRule"
  ADD COLUMN "dayCountBasis" "DayCountBasis",
  ADD COLUMN "observedHolidays" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
