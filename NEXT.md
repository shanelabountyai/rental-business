**2026-11-05 (latest): R-283 done.** `/money/quickbooks/reconciliation` (owner, `billing.connect`) compares a month per QuickBooks account, platform against the company file's `RB-<n>` entries (new `AccountingAdapter.listJournalEntries`), and lists failed, unposted, unplanned, excluded and missing-fee lines. "Sync now" and "Replay day" are audited. Sync and replay now hold a per-connection try-lock; a second run returns `busy` (D-399).

A bare `go` is **R-284**: historical backfill from a chosen start date in daily batches inside QuickBooks' 500 req/min per realm (PRD 09 Q11). Today the sync skips entries created before `connection.createdAt`, and the reconciliation page leaves them out too; the backfill is what brings them in. It must also read processing fees for payments settled before R-282b. Size M, money, so Opus.

**Left by R-283:** the real Intuit driver must also implement `listJournalEntries`. With the simulator, the QuickBooks side lives in process memory, so a deployed page can show phantom variance.

**Left by R-282a/b:**
- Deposit disposition (refund or forfeit) never reaches `LedgerEntry`, so Security Deposits Held only grows in QuickBooks.
- The simulated company file is in memory per process.
- Dispute fees are not read.
- R-284's backfill must also read fees for payments settled before R-282b.

**Local only:** `org-01-05-06.test.ts`'s ORG-01 control ("flags a write before the guard") fails on this machine on an unchanged tree and passes in CI. Not investigated.

**Real-Intuit carry-over:** Intuit needs one registered redirect URI, but the callback is built on each org's host. The real driver needs a callback on the platform host that hands back to the org host.

**Local test DB is bloated:** `rental_test` is 3.3 GB with 1.79M `Notification` rows. Under machine load the full unit run times out in notification-heavy files (`due-notices`, `notifications`, `follow-up`, `verify`, `jurisdiction/actions`), and all of them pass alone. Rebuilding `rental_test` from scratch would likely restore the full local run. Ask Shane before dropping it.

**Machine note:** run the unit suite as `npm test -- --maxWorkers=4`. On 2026-11-04 the cleanup hooks in `escalation.test.ts` and `notifications.test.ts` hit their 10s timeout under parallel load. Both files pass on their own, so rerun them alone before suspecting code. A killed vitest leaves `node (vitest N)` workers alive; kill them by cwd. Pass e2e specs as bare names. A new org-scoped table needs an `org_scope` trigger and an RLS policy, and a unit test that crosses orgs wraps the call in `asRequest`. `cron.spec.ts:59` fails locally and passes in CI.

**Carry-overs:** each deployed database must re-run `db:seed` and `db:migrate` (R-291a, R-291b, R-300a, R-300b, R-298a, R-298b, R-287a). The real StripeConnector, TwilioProvisioner, ResendProvisioner and VercelDomains still have to be built. `application_fee.refunded` is not handled. OQ-27 is open. The Neon dev branch reports every migration as unapplied.

**Shane owes:** counsel on the reason list (OQ-16). Before org #1 goes live: the neutral domain (D-324) plus wildcard DNS, a certificate and `RESEND_SHARED_FROM`. Before any connected org bills: a Connect endpoint and its secret.
