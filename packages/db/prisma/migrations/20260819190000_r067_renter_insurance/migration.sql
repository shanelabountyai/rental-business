-- LEASE-10 (R-067): renter's insurance tracking.

-- Document.type is a plain String, not a Postgres enum (validated at the
-- app layer only, packages/core/documents/validate.ts's own comment on why)
-- - so RENTER_INSURANCE_COI needs no DDL of its own here, just the table.

CREATE TABLE "RenterInsurancePolicy" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "policyNumber" TEXT,
    "liabilityCents" INTEGER,
    "expiresOn" DATE,
    "documentId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenterInsurancePolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RenterInsurancePolicy_documentId_key" ON "RenterInsurancePolicy"("documentId");
CREATE INDEX "RenterInsurancePolicy_leaseId_createdAt_idx" ON "RenterInsurancePolicy"("leaseId", "createdAt");

ALTER TABLE "RenterInsurancePolicy" ADD CONSTRAINT "RenterInsurancePolicy_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenterInsurancePolicy" ADD CONSTRAINT "RenterInsurancePolicy_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
