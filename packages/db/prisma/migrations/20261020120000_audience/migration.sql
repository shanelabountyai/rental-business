-- R-259 (PRD 08 A4): a saved announcement filter. It stores the segment
-- string the composer posts, not a list of recipients; who it reaches is
-- resolved at send time. Retired by `active = false`, never deleted.

CREATE TABLE "Audience" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Audience_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Audience_active_name_idx" ON "Audience"("active", "name");

ALTER TABLE "Audience" ADD CONSTRAINT "Audience_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "StaffUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
