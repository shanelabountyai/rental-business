-- R-039a: the tenant's debit day, and the owner's full-balance switch
-- (PAY-02; D-4, D-29).
--
-- debitDay: NULL means "the day rent is due", which is what every payer does
-- today and what most will keep doing. A number means the payer asked for a
-- later pull inside the grace period - rent due on the 1st, paid on the 3rd,
-- which is the difference between autopay that helps and autopay that
-- manufactures a failed debit and an NSF fee every month.
--
-- The ceiling is NOT enforced here, deliberately. Whether a day is safe
-- depends on the grace period in the property's versioned jurisdiction rule
-- (D-4), which a CHECK constraint cannot read - and hardcoding three days
-- into the schema would be exactly the kind of statutory number D-4 exists to
-- keep out of code. `debitDayDecision` in core owns it.
ALTER TABLE "LeasePayer" ADD COLUMN "debitDay" INTEGER;

ALTER TABLE "LeasePayer" ADD CONSTRAINT "LeasePayer_debitDay_range"
  CHECK ("debitDay" IS NULL OR ("debitDay" >= 1 AND "debitDay" <= 28));

-- requireFullBalance: an OWNER policy that overrides the collection method.
-- D-29 makes partial payments a property of the mode - `send_invoice` allows
-- them, `charge_automatically` cannot - but an owner may have a tenant on
-- invoicing (because they have no card) whom they still will not accept part
-- payments from, typically after a payment plan has already failed once.
--
-- On the LEASE rather than the payer: it is a decision about a tenancy, and a
-- two-payer lease where one may pay partially and the other may not is a
-- distinction nobody asked for and would have to be explained on every screen.
ALTER TABLE "Lease" ADD COLUMN "requireFullBalance" BOOLEAN NOT NULL DEFAULT false;
