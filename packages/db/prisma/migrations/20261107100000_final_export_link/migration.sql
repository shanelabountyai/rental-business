-- R-300b (D-388): the offboard run's emailed, code-guarded final export link.
CREATE TABLE "FinalExportLink" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FinalExportLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FinalExportLink_tokenHash_key" ON "FinalExportLink"("tokenHash");
CREATE INDEX "FinalExportLink_expiresAt_idx" ON "FinalExportLink"("expiresAt");
CREATE UNIQUE INDEX "FinalExportLink_orgId_staffUserId_key" ON "FinalExportLink"("orgId", "staffUserId");
ALTER TABLE "FinalExportLink" ADD CONSTRAINT "FinalExportLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinalExportLink" ADD CONSTRAINT "FinalExportLink_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "StaffUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
