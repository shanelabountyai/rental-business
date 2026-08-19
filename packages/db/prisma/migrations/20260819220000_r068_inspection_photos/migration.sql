-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "inspectionItemId" TEXT,
ADD COLUMN     "latitude" DECIMAL(9,6),
ADD COLUMN     "longitude" DECIMAL(9,6);

-- CreateIndex
CREATE INDEX "Document_inspectionItemId_idx" ON "Document"("inspectionItemId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_inspectionItemId_fkey" FOREIGN KEY ("inspectionItemId") REFERENCES "InspectionItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
