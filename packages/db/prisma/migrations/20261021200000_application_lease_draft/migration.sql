-- R-270 (PRD 08 C5): approving a whole household opens a lease draft, linked
-- back to the application it came from. One draft per application.

ALTER TABLE "Lease" ADD COLUMN "applicationId" TEXT;

CREATE UNIQUE INDEX "Lease_applicationId_key" ON "Lease"("applicationId");

ALTER TABLE "Lease" ADD CONSTRAINT "Lease_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
