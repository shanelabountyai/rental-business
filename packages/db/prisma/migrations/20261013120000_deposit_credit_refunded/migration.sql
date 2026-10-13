-- D-303: a credit balance on the tenant's ledger is returned with the deposit
-- refund. It is the tenant's rent coming back, not deposit money, so it
-- cannot go in `refundedCents`: `heldCents - appliedCents - refundedCents` is
-- the deposit liability, and a refund larger than the deposit would take it
-- below zero on the rent roll and the year-end packet.
--
-- Zero for every existing row: no disposition before this returned a credit.

ALTER TABLE "Deposit" ADD COLUMN "creditRefundedCents" INTEGER NOT NULL DEFAULT 0;
