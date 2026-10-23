-- R-274 (D-315): Organization is the tenant root above LegalEntity.
--
-- Only the root: the table, org #0, and orgId on the two tables that define
-- ownership. Scope, memberships and orgId on every other table are R-285.
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- Org #0 is the existing portfolio. A fixed id because the column defaults
-- below name it, and every environment (local, CI, demo, production) must
-- agree on it without a lookup.
INSERT INTO "Organization" ("id", "slug", "name", "updatedAt")
VALUES ('org_0', 'default', 'Default organisation', now() AT TIME ZONE 'UTC');

-- The DEFAULT backfills every existing row in the same statement.
ALTER TABLE "LegalEntity" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';
ALTER TABLE "Property" ADD COLUMN "orgId" TEXT NOT NULL DEFAULT 'org_0';

CREATE INDEX "LegalEntity_orgId_idx" ON "LegalEntity"("orgId");
CREATE INDEX "Property_orgId_idx" ON "Property"("orgId");

-- RESTRICT: an organisation is never deleted (D-319).
ALTER TABLE "LegalEntity" ADD CONSTRAINT "LegalEntity_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Property" ADD CONSTRAINT "Property_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An entity cannot move between organisations. Its properties, leases,
-- ledger and evidence trail would move with it into another customer's
-- hands; a transfer, if it is ever wanted, is an export and a re-import.
CREATE FUNCTION legal_entity_org_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."orgId" IS DISTINCT FROM OLD."orgId" THEN
    RAISE EXCEPTION 'LegalEntity.orgId cannot change (entity %)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER legal_entity_org_immutable
  BEFORE UPDATE OF "orgId" ON "LegalEntity"
  FOR EACH ROW EXECUTE FUNCTION legal_entity_org_immutable();

-- A property's org is DERIVED from its entity, never written. Deriving
-- rather than asserting means no writer has to know the org at all, and a
-- mismatch is impossible by construction instead of refused at runtime.
-- Covers a property re-parented to another entity too, which is how a
-- property could otherwise cross into another org.
CREATE FUNCTION property_derive_org() RETURNS trigger AS $$
BEGIN
  SELECT "orgId" INTO NEW."orgId" FROM "LegalEntity" WHERE "id" = NEW."legalEntityId";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER property_derive_org
  BEFORE INSERT OR UPDATE OF "legalEntityId", "orgId" ON "Property"
  FOR EACH ROW EXECUTE FUNCTION property_derive_org();
