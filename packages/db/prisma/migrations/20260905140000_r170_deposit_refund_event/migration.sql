-- R-170: the deposit refund becomes an event that can be recorded and paid.
--
-- Until now `finalizeDisposition` wrote `refundedCents` and a letter and
-- stopped, and every reader of the deposit liability subtracted that promise
-- as though the money had moved. These columns are the disbursement itself;
-- `refundPaidOn` is what releases the liability from here on.

ALTER TABLE "Deposit"
  ADD COLUMN "refundPaidOn" DATE,
  ADD COLUMN "refundMethod" "PaymentChannel",
  ADD COLUMN "refundReference" TEXT,
  ADD COLUMN "refundDocumentId" TEXT,
  ADD COLUMN "refundRecordedById" TEXT;

CREATE UNIQUE INDEX "Deposit_refundDocumentId_key" ON "Deposit"("refundDocumentId");

ALTER TABLE "Deposit"
  ADD CONSTRAINT "Deposit_refundDocumentId_fkey"
  FOREIGN KEY ("refundDocumentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Deposit"
  ADD CONSTRAINT "Deposit_refundRecordedById_fkey"
  FOREIGN KEY ("refundRecordedById") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
