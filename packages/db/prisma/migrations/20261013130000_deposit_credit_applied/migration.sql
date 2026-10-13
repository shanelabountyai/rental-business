-- D-307: a credit balance on the tenant's ledger is set against deductions
-- the deposit could not cover before any of it is returned. This is the part
-- of the credit that was applied that way, beside `creditRefundedCents`, the
-- part that came back. Neither is deposit money, so neither is in the
-- liability (`heldCents - appliedCents - refundedCents`).
--
-- Stored because the letter's arithmetic is locked when it is written: the
-- ledger moves afterwards, and the deposit screen and the dispute packet have
-- to show what the tenant was told.
--
-- Zero for every existing row: no disposition before this netted a credit.

ALTER TABLE "Deposit" ADD COLUMN "creditAppliedCents" INTEGER NOT NULL DEFAULT 0;
