-- R-285b: a scoped grant must never widen when its scope is deleted.
--
-- StaffAssignment.propertyId and .legalEntityId were ON DELETE SET NULL (the
-- Prisma default for an optional relation, R-004). Deleting a property or an
-- entity therefore turned a grant over that one house into propertyId = NULL,
-- legalEntityId = NULL - which `propertyScope` reads as portfolio-wide
-- (`everything`). A latent escalation: the narrower the grant, the wider it
-- became. RESTRICT refuses the delete instead; a grant is revoked (a
-- timestamp, ROLE-06) and its row kept, so the scope has to outlive it.
ALTER TABLE "StaffAssignment" DROP CONSTRAINT "StaffAssignment_propertyId_fkey";
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StaffAssignment" DROP CONSTRAINT "StaffAssignment_legalEntityId_fkey";
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
