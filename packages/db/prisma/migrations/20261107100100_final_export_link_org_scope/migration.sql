-- R-300b: FinalExportLink's org never changes (R-285a), as every org table's.
CREATE TRIGGER org_scope BEFORE UPDATE OF "orgId" ON "FinalExportLink" FOR EACH ROW EXECUTE FUNCTION org_scope();
