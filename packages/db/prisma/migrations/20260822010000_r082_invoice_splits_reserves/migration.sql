-- R-082: vendor invoice splitting (PAY-10) and reserve targets (PAY-11).
--
-- The CHECK constraints are the half of the split rule the database can hold
-- on its own. It cannot hold the other half - that the lines sum to the
-- vendor's printed total - because that is an aggregate across rows, and a
-- trigger enforcing it would fire mid-insert on the first line of every
-- correctly-balanced invoice. `validateVendorInvoice` owns that rule, and the
-- write is a single transaction so a half-entered invoice never lands.

-- CreateTable
CREATE TABLE "PropertyReserve" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "targetCents" INTEGER NOT NULL,
    "balanceCents" INTEGER,
    "balanceAsOf" DATE,
    "notes" TEXT,
    "updatedByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyReserve_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorInvoice" (
    "id" TEXT NOT NULL,
    "legalEntityId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "totalCents" INTEGER NOT NULL,
    "invoicedOn" DATE NOT NULL,
    "paidAt" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "notes" TEXT,
    "recordedByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorInvoiceSplit" (
    "id" TEXT NOT NULL,
    "vendorInvoiceId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "workOrderId" TEXT,
    "description" TEXT,

    CONSTRAINT "VendorInvoiceSplit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PropertyReserve_propertyId_key" ON "PropertyReserve"("propertyId");

-- CreateIndex
CREATE INDEX "VendorInvoice_legalEntityId_invoicedOn_idx" ON "VendorInvoice"("legalEntityId", "invoicedOn");

-- CreateIndex
CREATE INDEX "VendorInvoice_vendorId_paidAt_idx" ON "VendorInvoice"("vendorId", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "VendorInvoiceSplit_workOrderId_key" ON "VendorInvoiceSplit"("workOrderId");

-- CreateIndex
CREATE INDEX "VendorInvoiceSplit_vendorInvoiceId_idx" ON "VendorInvoiceSplit"("vendorInvoiceId");

-- CreateIndex
CREATE INDEX "VendorInvoiceSplit_propertyId_idx" ON "VendorInvoiceSplit"("propertyId");

-- AddForeignKey
ALTER TABLE "PropertyReserve" ADD CONSTRAINT "PropertyReserve_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyReserve" ADD CONSTRAINT "PropertyReserve_updatedByStaffId_fkey" FOREIGN KEY ("updatedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorInvoice" ADD CONSTRAINT "VendorInvoice_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorInvoice" ADD CONSTRAINT "VendorInvoice_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorInvoice" ADD CONSTRAINT "VendorInvoice_recordedByStaffId_fkey" FOREIGN KEY ("recordedByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorInvoiceSplit" ADD CONSTRAINT "VendorInvoiceSplit_vendorInvoiceId_fkey" FOREIGN KEY ("vendorInvoiceId") REFERENCES "VendorInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorInvoiceSplit" ADD CONSTRAINT "VendorInvoiceSplit_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorInvoiceSplit" ADD CONSTRAINT "VendorInvoiceSplit_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "WorkOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A zero line is a line somebody meant to fill in and did not; it would
-- export as a visible $0 deduction. A negative one is a credit memo, which
-- this product does not model - it would silently reduce a deduction with no
-- record of what it credited.
ALTER TABLE "VendorInvoiceSplit" ADD CONSTRAINT "VendorInvoiceSplit_amountCents_positive" CHECK ("amountCents" > 0);
ALTER TABLE "VendorInvoice" ADD CONSTRAINT "VendorInvoice_totalCents_positive" CHECK ("totalCents" > 0);

-- A negative reserve is not a fact about the world, it is a typo.
ALTER TABLE "PropertyReserve" ADD CONSTRAINT "PropertyReserve_targetCents_nonnegative" CHECK ("targetCents" >= 0);
ALTER TABLE "PropertyReserve" ADD CONSTRAINT "PropertyReserve_balanceCents_nonnegative" CHECK ("balanceCents" IS NULL OR "balanceCents" >= 0);

-- An undated balance always reads as current. Refused here as well as in
-- `validatePropertyReserve`, because this is the one pairing that makes the
-- whole record misleading rather than merely incomplete.
ALTER TABLE "PropertyReserve" ADD CONSTRAINT "PropertyReserve_balance_needs_date" CHECK ("balanceCents" IS NULL OR "balanceAsOf" IS NOT NULL);
