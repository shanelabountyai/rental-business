-- R-193 (review finding 7): owner-side outlay nobody invoiced - the property
-- tax bill, the landlord policy, the management fee - so `/reports/operating`'s
-- "All expenses" and "Net" can include them.
--
-- Not a ledger write (D-11). A vendor's own bill still belongs on
-- `VendorInvoice` (D-208).
--
-- The CHECKs are the half of the write rules the database can hold: a zero
-- amount is a line somebody meant to fill in, and an end date on a one-off
-- would mean a series that never existed.

CREATE TABLE "PropertyExpense" (
    "id" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "propertyId" TEXT,
    "category" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "paidOn" DATE NOT NULL,
    "recursMonthly" BOOLEAN NOT NULL DEFAULT false,
    "recurrenceEndsOn" DATE,
    "documentId" TEXT,
    "recordedByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyExpense_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PropertyExpense_amount_positive" CHECK ("amountCents" > 0),
    CONSTRAINT "PropertyExpense_end_needs_recurrence" CHECK ("recurrenceEndsOn" IS NULL OR "recursMonthly")
);

CREATE INDEX "PropertyExpense_legalEntityId_paidOn_idx" ON "PropertyExpense"("legalEntityId", "paidOn");

CREATE INDEX "PropertyExpense_propertyId_paidOn_idx" ON "PropertyExpense"("propertyId", "paidOn");

ALTER TABLE "PropertyExpense" ADD CONSTRAINT "PropertyExpense_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PropertyExpense" ADD CONSTRAINT "PropertyExpense_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PropertyExpense" ADD CONSTRAINT "PropertyExpense_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PropertyExpense" ADD CONSTRAINT "PropertyExpense_recordedByStaffId_fkey" FOREIGN KEY ("recordedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
