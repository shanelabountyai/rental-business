-- R-029: after-hours routing (MAINT-12, NOTIF-05).
--
-- Additive. `emergencyAvailable` defaults FALSE, which is deliberate and is
-- the safe direction: a vendor is not an emergency contact until somebody
-- says so, and the emergency list being empty falls back to the ordinary
-- vendor list rather than to nobody.

ALTER TABLE "StaffUser" ADD COLUMN "onCallFrom" TIMESTAMP(3);
ALTER TABLE "StaffUser" ADD COLUMN "onCallUntil" TIMESTAMP(3);

ALTER TABLE "Ticket" ADD COLUMN "acknowledgedAt" TIMESTAMP(3);
ALTER TABLE "Ticket" ADD COLUMN "acknowledgedByStaffId" TEXT;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_acknowledgedByStaffId_fkey"
  FOREIGN KEY ("acknowledgedByStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Vendor" ADD COLUMN "emergencyAvailable" BOOLEAN NOT NULL DEFAULT false;

-- The escalation sweep asks one question every tick: which EMERGENCY
-- tickets are still unacknowledged? Partial - an acknowledged ticket is
-- exactly the row it never needs to look at again.
CREATE INDEX "Ticket_unacknowledged_emergencies"
  ON "Ticket" ("createdAt")
  WHERE "acknowledgedAt" IS NULL;
