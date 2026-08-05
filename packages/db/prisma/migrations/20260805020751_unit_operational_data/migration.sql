-- AlterTable
ALTER TABLE "Unit" ADD COLUMN     "paintColor" TEXT;

-- CreateTable
CREATE TABLE "AccessCode" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT,
    "sealedCode" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdByStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appliance" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "make" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "installedOn" DATE,
    "filterSize" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appliance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UtilityAccount" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountNumber" TEXT,
    "nameOnAccountDuringTenancy" TEXT,
    "nameOnAccountVacancy" TEXT,
    "landlordRevertAgreement" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UtilityAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShutoffLocation" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShutoffLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessCode_unitId_type_effectiveTo_idx" ON "AccessCode"("unitId", "type", "effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "AccessCode_unitId_type_version_key" ON "AccessCode"("unitId", "type", "version");

-- CreateIndex
CREATE INDEX "Appliance_unitId_idx" ON "Appliance"("unitId");

-- CreateIndex
CREATE INDEX "UtilityAccount_unitId_idx" ON "UtilityAccount"("unitId");

-- CreateIndex
CREATE INDEX "ShutoffLocation_unitId_idx" ON "ShutoffLocation"("unitId");

-- CreateIndex
CREATE UNIQUE INDEX "ShutoffLocation_unitId_type_key" ON "ShutoffLocation"("unitId", "type");

-- AddForeignKey
ALTER TABLE "AccessCode" ADD CONSTRAINT "AccessCode_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessCode" ADD CONSTRAINT "AccessCode_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appliance" ADD CONSTRAINT "Appliance_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilityAccount" ADD CONSTRAINT "UtilityAccount_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShutoffLocation" ADD CONSTRAINT "ShutoffLocation_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
