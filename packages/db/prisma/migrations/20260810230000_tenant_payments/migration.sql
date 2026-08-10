-- R-037: tenant payments (PAY-01; D-29, D-12, D-4).
--
-- D-29 answered OQ-11: Stripe cannot do autopay and partial payments on one
-- subscription, so the collection method is PER PAYER and it switches.
-- Autopay tenants sit on `charge_automatically`; tenants who need to pay in
-- parts sit on `send_invoice`. Both Must stories ship, for the payers on the
-- mode that supports each.

-- Stripe's own values, spelled exactly as Stripe spells them. Lowercase
-- rather than this schema's usual SCREAMING_CASE on purpose: these strings go
-- straight onto the API and come straight back off it, and a mapping layer
-- between two spellings of one closed set is a translation nobody needs.
CREATE TYPE "CollectionMethod" AS ENUM ('charge_automatically', 'send_invoice');

-- Defaulted to autopay, which is what every payer provisioned by R-034 and
-- R-036 already is in Stripe: the column starts out agreeing with reality
-- rather than claiming a mode nobody was put on. A payer only moves to
-- `send_invoice` when somebody deliberately switches them.
ALTER TABLE "LeasePayer"
  ADD COLUMN "collectionMethod" "CollectionMethod" NOT NULL DEFAULT 'charge_automatically';

-- PAY-01's card pass-through as configuration, never a literal (D-4).
-- Several states restrict surcharging outright and some regulate rent
-- convenience fees specifically. Defaulting to permitted matches the Texas
-- seed this product ships with; a state that forbids it sets false in its own
-- versioned rule row rather than anybody editing code.
ALTER TABLE "JurisdictionRule"
  ADD COLUMN "cardSurchargePermitted" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "JurisdictionRule"
  ADD COLUMN "cardSurchargeMaxBps" INTEGER;

-- The tenant pay screen's own read: this payer's payments that Stripe has
-- accepted but not settled. An ACH debit sits here for three to five days,
-- and it is the fact that blocks a collection-method switch (D-29) as well as
-- the one a tenant needs to see so they do not pay the same rent twice.
-- Partial, because a settled payment is exactly the row this never asks for.
CREATE INDEX "Payment_in_flight"
  ON "Payment" ("leasePayerId")
  WHERE "status" = 'PENDING';
