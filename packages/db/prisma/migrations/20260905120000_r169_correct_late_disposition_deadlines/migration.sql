-- R-169: shorten the deposit-disposition deadlines that were frozen a day late.
--
-- `Lease.moveOutAt` is a `timestamp` holding UTC. `startDepositDisposition`
-- read it with `utcToBusinessDate` - the reader for a `@db.Date` - so a
-- move-out recorded at 7pm Central was already the NEXT calendar day in UTC,
-- and the statutory clock was frozen from that later day. The owner is then
-- working to a deadline the statute does not grant, which is the direction
-- that costs money: in Texas a disposition sent after the deadline is
-- bad-faith retention territory.
--
-- WHY THIS IS EXACT RATHER THAN A RECOMPUTE. The deadline is
-- `addBusinessDays(startDate, depositDispositionDays)`, and despite its name
-- `addBusinessDays` is plain UTC calendar-day addition (no weekend or holiday
-- roll - see R-182, which is the row that will change that). The days added
-- are therefore identical under both readers, and the ONLY difference is the
-- start date. So the correction is the date delta itself, and this migration
-- never has to resolve a JurisdictionRule - which matters, because
-- `startDepositDisposition` resolves the rule as of the moment it ran, and a
-- recompute today could silently pick up a different version and move a
-- deadline for a second, unrelated reason. `dispositionDueOn` has exactly one
-- writer, so there is no other way these rows could have been set.
--
-- ONE-DIRECTIONAL, DELIBERATELY. Only rows where the property-local day is
-- EARLIER than the UTC day are touched - western zones, evening move-outs -
-- which can only SHORTEN a deadline and so can only reduce exposure. A
-- property east of UTC has the mirror defect (the deadline was frozen a day
-- EARLY), and this leaves it alone: lengthening a running statutory deadline
-- is a legal act, not a bug fix, and D-12 freezes these on purpose. The owner
-- chose that asymmetry knowing it leaves the eastern case uncorrected; there
-- are no such properties today, and if one is onboarded the fix is a fresh
-- decision, not this migration.
--
-- OPEN DISPOSITIONS ONLY (`dispositionSentAt IS NULL`). Once the letter has
-- gone out the date is on a document a tenant holds; changing the row would
-- put the database and the evidence trail into disagreement, which is worse
-- than the wrong date.

-- `date - date` is an integer number of days in Postgres, and
-- `date - integer` is a date, so the arithmetic below stays in the date
-- domain and never becomes a timestamp.
UPDATE "Deposit" d
SET "dispositionDueOn" = d."dispositionDueOn" - (src.utc_date - src.local_date)
FROM (
  SELECT
    dep.id,
    (l."moveOutAt")::date AS utc_date,
    (l."moveOutAt" AT TIME ZONE 'UTC' AT TIME ZONE p.timezone)::date AS local_date
  FROM "Deposit" dep
  JOIN "Lease" l ON l.id = dep."leaseId"
  JOIN "Property" p ON p.id = l."propertyId"
  WHERE dep."dispositionSentAt" IS NULL
    AND dep."dispositionDueOn" IS NOT NULL
    AND l."moveOutAt" IS NOT NULL
) src
WHERE d.id = src.id
  AND src.local_date < src.utc_date;
