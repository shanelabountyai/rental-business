-- R-223: when a ticket BECAME an emergency, which is the moment R-029's
-- fifteen-minute escalation clock and its 24-hour window measure from.
--
-- `createdAt` was that moment only while the portal was the one writer of
-- EMERGENCY. Staff can now escalate a ticket that arrived by text hours ago,
-- and measuring from its creation would page the owner on the next tick
-- (three hours "unacknowledged") or never (older than a day).
ALTER TABLE "Ticket" ADD COLUMN "emergencyAt" TIMESTAMP(3);

UPDATE "Ticket" SET "emergencyAt" = "createdAt" WHERE "priority" = 'EMERGENCY';

-- Stamped by the database, not by each writer: every path that makes a
-- ticket EMERGENCY - the portal, staff triage, a seed, a fixture - gets the
-- clock without having to remember it. An INSERT takes the row's own
-- createdAt (a born emergency is an emergency from the start); an UPDATE
-- takes the current UTC time. Never overwritten once set, so the clock cannot be restarted
-- by re-saving the same priority.
CREATE FUNCTION ticket_stamp_emergency_at() RETURNS trigger AS $$
BEGIN
  IF NEW."priority" = 'EMERGENCY' AND NEW."emergencyAt" IS NULL THEN
    -- AT TIME ZONE 'UTC': the column is a zoneless TIMESTAMP holding UTC,
    -- which is how Prisma writes every DateTime. A bare now() is converted
    -- to the SESSION's zone on assignment, so the first version of this
    -- stamped a Chicago session's escalation clock five hours in the past -
    -- the owner paged on the very next tick.
    IF TG_OP = 'INSERT' THEN
      NEW."emergencyAt" := COALESCE(NEW."createdAt", now() AT TIME ZONE 'UTC');
    ELSE
      NEW."emergencyAt" := now() AT TIME ZONE 'UTC';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ticket_stamp_emergency_at
  BEFORE INSERT OR UPDATE OF "priority" ON "Ticket"
  FOR EACH ROW EXECUTE FUNCTION ticket_stamp_emergency_at();
