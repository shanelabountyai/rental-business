-- INSP-04 (R-073): periodic inspections (annual interior, seasonal exterior,
-- drive-bys) on the same checklist machinery R-068 already built. No new
-- table, no new InspectionType values - PERIODIC/SEASONAL/DRIVE_BY have
-- existed since the engine's own migration and a PM could already start one
-- by hand. The only new fact this item needs: which checklist is the
-- default for auto-scheduling each of those three types.
ALTER TABLE "InspectionTemplate" ADD COLUMN "defaultForType" "InspectionType";

-- At most one template can be the default for a given type. Postgres treats
-- NULLs as distinct in a unique index, so any number of templates with no
-- default assignment coexist fine - only a real duplicate assignment is
-- refused.
CREATE UNIQUE INDEX "InspectionTemplate_defaultForType_key" ON "InspectionTemplate"("defaultForType");
