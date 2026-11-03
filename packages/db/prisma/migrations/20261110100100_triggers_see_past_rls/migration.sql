-- R-287a: every trigger function runs as its owner, so an invariant sees the
-- whole database whoever is writing. Found by ORG-03 with RLS on: org_scope
-- looks a row's parent up to refuse a cross-org reference, and under
-- rental_rls another org's parent is INVISIBLE - so the lookup found nothing,
-- the refusal never fired, and the foreign key (which RLS does not filter)
-- let a VendorInvoice point at org B's vendor. A trigger that can be blinded
-- by the caller's role is not an invariant. search_path is pinned, as a
-- SECURITY DEFINER function must have it.
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN
    SELECT DISTINCT t.tgfoid::regprocedure FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE NOT t.tgisinternal AND n.nspname = 'public'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = public', f);
  END LOOP;
END $$;
