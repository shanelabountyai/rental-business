-- INSP-05 (R-074): tenant self-guided move-in condition report. One new
-- fact - whether staff created a MOVE_IN inspection for the tenant to walk
-- themselves from the portal, rather than staff walking it in person. Both
-- workflows share the exact same Inspection/InspectionItem rows and
-- lifecycle facts (R-068); this column is only what tells the tenant portal
-- actions and the walkthrough-window job which MOVE_IN inspections they may
-- touch.
ALTER TABLE "Inspection" ADD COLUMN "selfGuided" BOOLEAN NOT NULL DEFAULT false;
