-- R-166: a printable counter receipt per payment, and undeposited offline
-- payments grouped into a printable deposit slip.

ALTER TABLE "Payment"
  ADD COLUMN "receiptDocumentId" TEXT,
  ADD COLUMN "depositBatchId" TEXT,
  ADD COLUMN "depositedAt" TIMESTAMP(3),
  ADD COLUMN "depositSlipDocumentId" TEXT;

CREATE UNIQUE INDEX "Payment_receiptDocumentId_key" ON "Payment"("receiptDocumentId");
CREATE INDEX "Payment_depositBatchId_idx" ON "Payment"("depositBatchId");

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_receiptDocumentId_fkey"
  FOREIGN KEY ("receiptDocumentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_depositSlipDocumentId_fkey"
  FOREIGN KEY ("depositSlipDocumentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
