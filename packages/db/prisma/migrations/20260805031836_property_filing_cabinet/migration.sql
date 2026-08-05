-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "costBasisCents" INTEGER;

-- CreateTable
CREATE TABLE "Mortgage" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "lender" TEXT NOT NULL,
    "originalAmountCents" INTEGER,
    "currentBalanceCents" INTEGER,
    "rateType" TEXT NOT NULL,
    "interestRateBps" INTEGER,
    "armAdjustmentDate" DATE,
    "maturityDate" DATE,
    "isBalloon" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mortgage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsurancePolicy" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "policyNumber" TEXT,
    "limitsCents" INTEGER,
    "deductibleCents" INTEGER,
    "lossOfRents" BOOLEAN NOT NULL DEFAULT false,
    "renewsOn" DATE NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsurancePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HoaInfo" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "name" TEXT,
    "contactInfo" TEXT,
    "hasRentalCap" BOOLEAN NOT NULL DEFAULT false,
    "rentalCapPolicy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HoaInfo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Warranty" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "coverageSummary" TEXT,
    "expiresOn" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Warranty_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Mortgage_propertyId_idx" ON "Mortgage"("propertyId");

-- CreateIndex
CREATE INDEX "InsurancePolicy_propertyId_renewsOn_idx" ON "InsurancePolicy"("propertyId", "renewsOn");

-- CreateIndex
CREATE UNIQUE INDEX "HoaInfo_propertyId_key" ON "HoaInfo"("propertyId");

-- CreateIndex
CREATE INDEX "Warranty_propertyId_idx" ON "Warranty"("propertyId");

-- AddForeignKey
ALTER TABLE "Mortgage" ADD CONSTRAINT "Mortgage_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsurancePolicy" ADD CONSTRAINT "InsurancePolicy_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HoaInfo" ADD CONSTRAINT "HoaInfo_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Warranty" ADD CONSTRAINT "Warranty_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
