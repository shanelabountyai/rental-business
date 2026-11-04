**2026-11-04 (latest): R-280 done (`6450fdf6`).** Each LegalEntity can now connect its own QuickBooks file at `/money/quickbooks`, using `QuickBooksConnection` (D-396: its own table, not `OrgIntegration`). `quickBooksAccessToken(legalEntityId)` is the only way to get a token: it refreshes under an advisory lock, and when Intuit refuses a refresh it marks the connection RECONNECT_NEEDED and raises a task. Intuit is simulated (`SimulatedQuickBooksGrant`).

A bare `go` is **R-282**: the nightly sync job and journal-entry builder, size L. **R-281 is withdrawn (D-397):** the account and Class/Location mapping is customer-specific, so Shane sets it during onboarding and there is no screen. R-282 therefore carries the minimum mapping store, filled by an onboarding script or seed rather than a UI, plus the rule that an unmapped category blocks the sync. Fetch tokens through `quickBooksAccessToken` and read the property field from `QuickBooksConnection.propertyField`. CI for R-280 went red on three registries (`actions.manifest.ts`, `route-guards.test.ts`, the org-less model list), fixed in `61cb373a`. A new action, route or org-less model needs all three.

**Local only:** `org-01-05-06.test.ts`'s ORG-01 control ("flags a write before the guard") fails on this machine on an unchanged tree and passes in CI. Not investigated.

**Real-Intuit carry-over:** Intuit needs one registered redirect URI, but the callback is built on each org's host. The real driver needs a callback on the platform host that hands back to the org host.

**Local test DB is bloated:** `rental_test` is 3.3 GB with 1.79M `Notification` rows. Under machine load the full unit run times out in notification-heavy files (`due-notices`, `notifications`, `follow-up`, `verify`, `jurisdiction/actions`), and all of them pass alone. Rebuilding `rental_test` from scratch would likely restore the full local run. Ask Shane before dropping it.

**Open for R-282:** `Payment` carries no Stripe fee amount and nothing projects one. Q8 needs a source, either the balance transaction or the charge.

**Machine note:** run the unit suite as `npm test -- --maxWorkers=4`. On 2026-11-04 the cleanup hooks in `escalation.test.ts` and `notifications.test.ts` hit their 10s timeout under parallel load. Both files pass on their own, so rerun them alone before suspecting code. A killed vitest leaves `node (vitest N)` workers alive; kill them by cwd. Pass e2e specs as bare names. A new org-scoped table needs an `org_scope` trigger and an RLS policy, and a unit test that crosses orgs wraps the call in `asRequest`. `cron.spec.ts:59` fails locally and passes in CI.

**Carry-overs:** each deployed database must re-run `db:seed` and `db:migrate` (R-291a, R-291b, R-300a, R-300b, R-298a, R-298b, R-287a). The real StripeConnector, TwilioProvisioner, ResendProvisioner and VercelDomains still have to be built. `application_fee.refunded` is not handled. OQ-27 is open. The Neon dev branch reports every migration as unapplied.

**Shane owes:** counsel on the reason list (OQ-16). Before org #1 goes live: the neutral domain (D-324) plus wildcard DNS, a certificate and `RESEND_SHARED_FROM`. Before any connected org bills: a Connect endpoint and its secret.
