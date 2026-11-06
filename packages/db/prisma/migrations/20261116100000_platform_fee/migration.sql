-- R-296 (D-322): the platform's application fee per org, in basis points,
-- set from the console (PRD 11 §4.6: 0-1000). Zero takes no fee.
ALTER TABLE "Organization" ADD COLUMN "platformFeeBps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_platformFeeBps_check"
  CHECK ("platformFeeBps" BETWEEN 0 AND 1000);

-- The fee last pushed onto the payer's subscription: a record of the
-- instruction, like "stripeAmountCents", so the simulator has its own
-- answer (D-27). Null = none pushed yet, read as zero.
ALTER TABLE "LeasePayer" ADD COLUMN "stripeFeeBps" INTEGER;
