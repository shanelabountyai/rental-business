-- R-224: one counter payment can now be spread over several open invoices.
--
-- Stripe attaches money to one invoice at a time, so a cheque for two months'
-- arrears is two attachments and two `invoice.updated` events. The webhook
-- claims each event against a split rather than against the Payment's own
-- `stripeInvoiceId`, which can name only one.
CREATE TABLE "PaymentInvoiceSplit" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "stripeInvoiceId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentInvoiceSplit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentInvoiceSplit_paymentId_stripeInvoiceId_key" ON "PaymentInvoiceSplit"("paymentId", "stripeInvoiceId");
CREATE INDEX "PaymentInvoiceSplit_stripeInvoiceId_idx" ON "PaymentInvoiceSplit"("stripeInvoiceId");

ALTER TABLE "PaymentInvoiceSplit" ADD CONSTRAINT "PaymentInvoiceSplit_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every counter payment written before this had exactly one invoice, held on
-- the row itself. Backfilled so the claim has one shape to read.
INSERT INTO "PaymentInvoiceSplit" ("id", "paymentId", "stripeInvoiceId", "amountCents", "createdAt")
SELECT 'pis_' || "id", "id", "stripeInvoiceId", "amountCents", "createdAt"
FROM "Payment"
WHERE "receivedByStaffId" IS NOT NULL AND "stripeInvoiceId" IS NOT NULL;
