**2026-11-04 (latest): R-282b done (`6824ccd3`).** Every settled Stripe payment now stores what Stripe kept from it in the append-only `StripeProcessingFee` (one row per payment, never a `LedgerEntry`). The webhook reads it after the projection commits, through `BillingProvider.getProcessingFee`. The QuickBooks sync adds a Merchant Fees debit and an Undeposited Funds credit to the payment's journal, so the net matches the bank. An unmapped `MERCHANT_FEES` blocks the sync like any other key. The fee posted is the whole balance-transaction `fee`, Stripe's and the platform's together.

A bare `go` is **R-283**: the reconciliation page plus "sync now" and "replay date" (PRD 09 Q9, Q10). It is Owner/Admin only and audited. The page has a month picker, the platform total against the QuickBooks total per mapped account, and a list of unsynced or failed lines. That list includes the exclusions R-282a links with `excludedReason`, journals carrying `lastError`, and settled card or ACH payments with no `StripeProcessingFee` row. A fee read that failed is not retried; the page should surface it. Size M, permissions plus money, so Opus.

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
