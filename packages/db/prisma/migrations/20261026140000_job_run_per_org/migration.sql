-- R-290: a portfolio-wide run is one per ORG per day, not one per deployment.
--
-- The cron now claims one `JobRun` per org per tick (propertyId NULL). Under
-- the old key - (jobType, COALESCE(propertyId, ''), businessDate) - every
-- org's claim collided with the first org's, so org #1's daily run would have
-- read as `already_ran` for ever. Adding orgId changes nothing for a
-- per-property row: its org is derived from the property (org_scope), so the
-- property alone already determined it.
DROP INDEX "JobRun_one_run_per_local_day";
CREATE UNIQUE INDEX "JobRun_one_run_per_local_day"
  ON "JobRun" ("jobType", "orgId", COALESCE("propertyId", ''), "businessDate");
