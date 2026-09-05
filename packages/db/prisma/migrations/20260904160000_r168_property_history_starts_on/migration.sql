-- R-168: the date this owner's own records for a property begin. Nullable,
-- no default - every property that already exists has no such gap, and one
-- imported later sets it explicitly.
ALTER TABLE "Property" ADD COLUMN "historyStartsOn" DATE;
