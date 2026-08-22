-- R-081d (RPT-07): a Document can belong to the ENTITY rather than to any one
-- property under it.
--
-- The year-end tax packet is per legal entity - Schedule E splits by address
-- but deposit liability and the 1099-NEC list are entity-wide, so there is no
-- property it honestly belongs to. Attaching it to an arbitrary house would be
-- a false claim, and leaving both keys null makes it unreachable: staff access
-- to a document is scoped through its owning record, so a document with
-- neither is correctly refused to everybody.
--
-- ComplianceItem already carries exactly this property/entity pair for exactly
-- this reason (R-077), and its entity-level completions have been writing
-- documents with no owner since then - fixed in the same change.

ALTER TABLE "Document" ADD COLUMN "legalEntityId" TEXT;

CREATE INDEX "Document_legalEntityId_type_idx" ON "Document"("legalEntityId", "type");

-- SET NULL, matching `Document_propertyId_fkey` exactly. Prisma's default for
-- an optional relation, and writing anything else here without saying so in
-- schema.prisma is drift CI would catch (and has, before).
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_legalEntityId_fkey"
  FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
