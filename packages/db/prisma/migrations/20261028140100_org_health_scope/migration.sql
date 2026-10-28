-- R-303: OrgHealth's org is its key and never changes, like OrgIntegration's.
-- A separate migration because 20261028140000 was already applied (CLAUDE.md:
-- never edit an applied migration).
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "OrgHealth" FOR EACH ROW EXECUTE FUNCTION org_scope();
