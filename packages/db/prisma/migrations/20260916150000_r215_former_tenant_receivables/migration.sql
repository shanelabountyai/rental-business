-- R-215: money owed by a former tenant stays in the product.

-- The part of a disposition's deductions the deposit could not cover, billed
-- as its own charge. Unique, so a disposition bills it at most once.
ALTER TABLE "Charge" ADD COLUMN "depositId" TEXT;
CREATE UNIQUE INDEX "Charge_depositId_key" ON "Charge"("depositId");
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_depositId_fkey"
  FOREIGN KEY ("depositId") REFERENCES "Deposit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The owner's decision to stop pursuing a former tenant's balance (D-233).
-- Not a ledger event: the debt is still owed. Append-only, like the rest of
-- the evidence trail.
CREATE TABLE "ReceivableWriteOff" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "writtenOffOn" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivableWriteOff_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReceivableWriteOff_leaseId_idx" ON "ReceivableWriteOff"("leaseId");
CREATE INDEX "ReceivableWriteOff_propertyId_idx" ON "ReceivableWriteOff"("propertyId");

ALTER TABLE "ReceivableWriteOff" ADD CONSTRAINT "ReceivableWriteOff_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivableWriteOff" ADD CONSTRAINT "ReceivableWriteOff_leaseId_fkey"
  FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivableWriteOff" ADD CONSTRAINT "ReceivableWriteOff_staffUserId_fkey"
  FOREIGN KEY ("staffUserId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER "ReceivableWriteOff_append_only"
  BEFORE UPDATE OR DELETE ON "ReceivableWriteOff"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "ReceivableWriteOff_no_truncate"
  BEFORE TRUNCATE ON "ReceivableWriteOff"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
