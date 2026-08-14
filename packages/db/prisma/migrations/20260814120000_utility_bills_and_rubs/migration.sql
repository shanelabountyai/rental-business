-- R-042 (PAY-08): RUBS. One utility bill for a property with one meter and
-- several units, and the record of how it was split.
--
-- `allocate()` has been in packages/core since R-002, tested, with a comment
-- naming RUBS as its purpose and no caller. This is what gives it one.
--
-- Occupant count is deliberately not a method here - see the enum's comment
-- in schema.prisma. `LeaseTenant` is adults-only by design, so a family of
-- four reads as two.

CREATE TYPE "RubsMethod" AS ENUM ('EQUAL', 'BEDROOMS', 'SQUARE_FEET');

CREATE TABLE "UtilityBill" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "utilityType" TEXT NOT NULL,
    "provider" TEXT,
    -- Calendar days, not timestamps. A billing period is what the meter
    -- reader wrote down, and no timezone may touch it (D-3).
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "method" "RubsMethod" NOT NULL,
    "documentId" TEXT,
    "allocatedAt" TIMESTAMP(3),
    "allocatedByStaffId" TEXT,
    "landlordCents" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UtilityBill_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UtilityBill_propertyId_periodEnd_idx" ON "UtilityBill"("propertyId", "periodEnd");

ALTER TABLE "UtilityBill" ADD CONSTRAINT "UtilityBill_propertyId_fkey"
    FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "UtilityBill" ADD CONSTRAINT "UtilityBill_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UtilityBill" ADD CONSTRAINT "UtilityBill_allocatedByStaffId_fkey"
    FOREIGN KEY ("allocatedByStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The share's link back to the bill it came out of. RESTRICT, like every
-- other evidence key in this schema: the bill IS the defence of the charge,
-- and deleting it would leave a tenant billed for a share of nothing.
ALTER TABLE "Charge" ADD COLUMN "utilityBillId" TEXT;

ALTER TABLE "Charge" ADD CONSTRAINT "Charge_utilityBillId_fkey"
    FOREIGN KEY ("utilityBillId") REFERENCES "UtilityBill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
