-- R-053: segment announcements need something to segment ON (COMM-04).
--
-- Freeform, not a lookup table. A real metro ("Dallas-Fort Worth") spans city
-- boundaries a `city` match cannot group, and inventing a canonical geography
-- or tag taxonomy for a 10-50 unit portfolio is scaffolding nobody asked for.
-- Two properties disagreeing on spelling just fail to group on the segment
-- picker - visible and correctable, unlike a wrong automatic grouping.
ALTER TABLE "Property" ADD COLUMN "metro" TEXT;
ALTER TABLE "Property" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';
