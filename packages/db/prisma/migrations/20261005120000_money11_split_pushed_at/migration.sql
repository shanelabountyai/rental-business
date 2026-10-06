-- MONEY-11/12: record that a split's push to Stripe actually returned.
--
-- A split was written before its push and deleted if the push threw. A
-- timeout AFTER Stripe wrote the record throws too, so the echo found no
-- split and credited the money a second time (MONEY-11); a process that died
-- mid-push left a split nothing had sent, free to absorb Stripe's own retry
-- for two days (MONEY-12). `pushedAt` tells the two apart from a push that
-- landed.
--
-- Backfilled from `createdAt`: until now a split that did not land was
-- deleted, so every surviving row is one whose push returned.

ALTER TABLE "PaymentInvoiceSplit" ADD COLUMN "pushedAt" TIMESTAMP(3);

UPDATE "PaymentInvoiceSplit" SET "pushedAt" = "createdAt";
