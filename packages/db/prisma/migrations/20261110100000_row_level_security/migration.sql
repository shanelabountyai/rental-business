-- R-287a (PRD 10 §1.6, D-317, D-391): row-level security as the BACKSTOP to
-- the column + scope + harness, never instead of it.
--
-- Every role this app connects as bypasses RLS: a superuser locally and in
-- CI, and Neon's owner has BYPASSRLS. So the policies below bind a separate
-- NOLOGIN role, and `packages/db/rls.ts` drops into it per transaction with
-- set_config('role', 'rental_rls', true) beside set_config('app.org_id', …).
-- Nothing that does not switch role - migrations, seeds, the platform
-- console, webhooks, production while RLS_ENFORCE is off - is affected.

-- Roles are cluster-wide: rental_test, rental_ci and rental_demo share one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rental_rls') THEN
    CREATE ROLE rental_rls NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- A non-superuser (Neon's owner) may SET ROLE only to a role it is a member of.
GRANT rental_rls TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO rental_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rental_rls;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rental_rls;
-- Tables a later migration creates are granted too; their POLICY is not
-- automatic, which is what schema.test.ts's ORG-06 check is for.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rental_rls;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rental_rls;

-- One policy per org-owned table: every table with an orgId column except
-- OrgMembership, which is a staff identity's list of orgs and is org-less by
-- ORG-06's own list. AuditLog's null-org PLATFORM rows are invisible to the
-- role, which is right: no org actor reads them.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'orgId' AND table_name <> 'OrgMembership'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I TO rental_rls
         USING ("orgId" = current_setting(''app.org_id'', true))
         WITH CHECK ("orgId" = current_setting(''app.org_id'', true))', t);
  END LOOP;
END $$;
