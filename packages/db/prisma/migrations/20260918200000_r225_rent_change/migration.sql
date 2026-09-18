-- R-225: a rent increase on a running tenancy waits for its effective date
-- and its served notice instead of reaching the next invoice at once.
CREATE TYPE "RentChangeStatus" AS ENUM ('SCHEDULED', 'APPLIED', 'HELD', 'CANCELLED');

CREATE TABLE "RentChange" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "fromCents" INTEGER NOT NULL,
    "toCents" INTEGER NOT NULL,
    "effectiveOn" DATE NOT NULL,
    "noticeId" TEXT NOT NULL,
    "overrideReason" TEXT,
    "status" "RentChangeStatus" NOT NULL DEFAULT 'SCHEDULED',
    "heldReason" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RentChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RentChange_leaseId_idx" ON "RentChange"("leaseId");
CREATE INDEX "RentChange_propertyId_status_effectiveOn_idx" ON "RentChange"("propertyId", "status", "effectiveOn");

ALTER TABLE "RentChange" ADD CONSTRAINT "RentChange_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RentChange" ADD CONSTRAINT "RentChange_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RentChange" ADD CONSTRAINT "RentChange_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "Notice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
