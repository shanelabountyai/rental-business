-- R-063 (LEASE-06, DOC-02; D-7, OQ-7): lease generation + SimulatedESignAdapter.
--
-- Property gets the four addenda-trigger facts nothing else could derive
-- (LEAD_PAINT already reads Property.yearBuilt, HOA_RULES already reads
-- HoaInfo). DocumentTemplate gets per-state selection and, for an ADDENDUM
-- template, which trigger it answers. LeaseEnvelope/LeaseSigner are new:
-- one envelope per lease, tracking the simulated e-sign provider's own
-- envelope/signer ids, viewed/signed timestamps and the completion
-- certificate's inputs - the adapter itself holds no state (D-27).

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "bedbugHistoryNotes" TEXT,
ADD COLUMN     "hasPool" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasWellOrSeptic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "moldHistoryNotes" TEXT;

-- AlterTable
ALTER TABLE "DocumentTemplate" ADD COLUMN     "addendumKey" TEXT,
ADD COLUMN     "state" TEXT;

-- CreateIndex
CREATE INDEX "DocumentTemplate_documentType_state_idx" ON "DocumentTemplate"("documentType", "state");

-- CreateEnum
CREATE TYPE "LeaseEnvelopeStatus" AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_SIGNED', 'COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "LeaseSignerStatus" AS ENUM ('PENDING', 'SENT', 'VIEWED', 'SIGNED', 'DECLINED');

-- CreateEnum
CREATE TYPE "LeaseSignerRole" AS ENUM ('TENANT', 'GUARANTOR');

-- CreateTable
CREATE TABLE "LeaseEnvelope" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "status" "LeaseEnvelopeStatus" NOT NULL DEFAULT 'DRAFT',
    "addendumKeys" TEXT[],
    "providerId" TEXT,
    "draftDocumentId" TEXT,
    "executedDocumentId" TEXT,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaseEnvelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaseSigner" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "role" "LeaseSignerRole" NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "tenantId" TEXT,
    "guarantorId" TEXT,
    "status" "LeaseSignerStatus" NOT NULL DEFAULT 'PENDING',
    "providerSignerId" TEXT,
    "viewedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "signedName" TEXT,
    "signedIp" TEXT,
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaseSigner_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeaseEnvelope_leaseId_idx" ON "LeaseEnvelope"("leaseId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseEnvelope_providerId_key" ON "LeaseEnvelope"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseEnvelope_draftDocumentId_key" ON "LeaseEnvelope"("draftDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseEnvelope_executedDocumentId_key" ON "LeaseEnvelope"("executedDocumentId");

-- CreateIndex
CREATE INDEX "LeaseEnvelope_status_idx" ON "LeaseEnvelope"("status");

-- CreateIndex
CREATE INDEX "LeaseSigner_envelopeId_order_idx" ON "LeaseSigner"("envelopeId", "order");

-- AddForeignKey
ALTER TABLE "LeaseEnvelope" ADD CONSTRAINT "LeaseEnvelope_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaseEnvelope" ADD CONSTRAINT "LeaseEnvelope_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "DocumentTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaseEnvelope" ADD CONSTRAINT "LeaseEnvelope_draftDocumentId_fkey" FOREIGN KEY ("draftDocumentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaseEnvelope" ADD CONSTRAINT "LeaseEnvelope_executedDocumentId_fkey" FOREIGN KEY ("executedDocumentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaseSigner" ADD CONSTRAINT "LeaseSigner_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "LeaseEnvelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaseSigner" ADD CONSTRAINT "LeaseSigner_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaseSigner" ADD CONSTRAINT "LeaseSigner_guarantorId_fkey" FOREIGN KEY ("guarantorId") REFERENCES "Guarantor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
