-- R-079: vendor invoice status (MAINT-09) - "received" and "approved for
-- payment" are both derived from existing columns; only "paid" needed a
-- new fact.

-- AlterTable
ALTER TABLE "WorkOrder" ADD COLUMN     "invoicePaidAt" TIMESTAMP(3),
ADD COLUMN     "invoicePaymentMethod" TEXT;
