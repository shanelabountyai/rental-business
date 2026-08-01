-- AlterTable
ALTER TABLE "StaffUser" ADD COLUMN     "approveWorkOrderCents" INTEGER,
ADD COLUMN     "waiveFeeCents" INTEGER;

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "permissions" TEXT[],
    "defaultApproveWorkOrderCents" INTEGER,
    "defaultWaiveFeeCents" INTEGER,
    "system" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffAssignment" (
    "id" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "propertyId" TEXT,
    "grantedByStaffId" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");

-- CreateIndex
CREATE INDEX "StaffAssignment_staffUserId_revokedAt_idx" ON "StaffAssignment"("staffUserId", "revokedAt");

-- CreateIndex
CREATE INDEX "StaffAssignment_propertyId_idx" ON "StaffAssignment"("propertyId");

-- CreateIndex
CREATE INDEX "StaffAssignment_legalEntityId_idx" ON "StaffAssignment"("legalEntityId");

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_staffUserId_fkey" FOREIGN KEY ("staffUserId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_grantedByStaffId_fkey" FOREIGN KEY ("grantedByStaffId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Scope integrity.
--
-- A StaffAssignment expresses its scope by which column is set:
--   both null           - portfolio-wide (D-5's owner)
--   legalEntityId set   - every property of that entity
--   propertyId set      - that property only
--
-- Setting both is meaningless, and the dangerous kind of meaningless: code
-- reading one column would see a narrow grant while code reading the other saw
-- a wide one, and the two would disagree about what a "property-scoped" user
-- can see. Rejecting the row is cheaper than deciding which reader is right.
-- ---------------------------------------------------------------------------

ALTER TABLE "StaffAssignment"
  ADD CONSTRAINT "StaffAssignment_scope_is_unambiguous"
  CHECK ("propertyId" IS NULL OR "legalEntityId" IS NULL);

-- One live grant of a given role over a given scope per user. Without this,
-- revoking an assignment can silently leave a duplicate behind still granting
-- the same access - and the revocation looks like it worked.
--
-- Partial on revokedAt IS NULL so the history that ROLE-06 requires us to keep
-- does not collide with the grant that replaced it. COALESCE because NULL
-- never equals NULL, so a plain unique index would not constrain the
-- portfolio-wide rows at all - which are exactly the most privileged ones.
CREATE UNIQUE INDEX "StaffAssignment_one_live_grant"
  ON "StaffAssignment" (
    "staffUserId",
    "roleId",
    COALESCE("propertyId", ''),
    COALESCE("legalEntityId", '')
  )
  WHERE "revokedAt" IS NULL;
