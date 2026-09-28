-- MONEY-01: a portal payment's money is projected from its PaymentIntent and
-- then pushed to the open invoices as splits. Each push echoes back as an
-- invoice.updated that must be absorbed once, with no ledger entry - this
-- column is that claim. Null on every existing (counter) split.
ALTER TABLE "PaymentInvoiceSplit" ADD COLUMN "claimedByEventId" TEXT;
CREATE UNIQUE INDEX "PaymentInvoiceSplit_claimedByEventId_key" ON "PaymentInvoiceSplit"("claimedByEventId");
