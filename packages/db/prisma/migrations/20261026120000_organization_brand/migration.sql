-- R-289: brand as runtime data (PRD 10 §4). Null means the Homestead default
-- (D-163), so org #0 renders exactly as before.
ALTER TABLE "Organization" ADD COLUMN "colorPrimary" TEXT;
ALTER TABLE "Organization" ADD COLUMN "colorAccent" TEXT;
ALTER TABLE "Organization" ADD COLUMN "supportPhone" TEXT;
ALTER TABLE "Organization" ADD COLUMN "supportEmail" TEXT;

-- The colours are rendered into a <style> block, so the database refuses
-- anything that is not a plain hex colour: no CSS can be smuggled in.
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_colorPrimary_hex"
  CHECK ("colorPrimary" ~ '^#[0-9a-f]{6}$');
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_colorAccent_hex"
  CHECK ("colorAccent" ~ '^#[0-9a-f]{6}$');

-- Org #0's name is now what every page title, the SMS footer and the opt-out
-- page print, so it takes the name those surfaces already said.
UPDATE "Organization" SET "name" = 'Rental Operations'
WHERE "id" = 'org_0' AND "name" = 'Default organisation';
