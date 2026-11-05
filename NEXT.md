**2026-11-05 (latest): R-297 done** (`86f399c5`, D-401). Screening criteria versions and decision reasons are per org now. A reason must rest on a criterion that is in force in the applicant's pinned version. Owners add and retire reasons on `/screening-criteria`. The quarterly adverse-action report is at `/screening-criteria/report`, with a CSV. Setup step 8 now also needs published criteria and one selectable reason.

CI is green (run 42126436044). R-297 also fixed R-283's racy `quickbooks-sync.test.ts` lock test.

A bare `go` now means R-298 is next by PRD 10 §10's order. Check the backlog first: R-272, R-273 and R-278 are gated, and R-296 is the last item.

**Left by R-297:** a new org starts with no criteria and no reasons; step 8 says so. The criterion check inside `recordScreeningDecision` has no test that drives the action. The list's wording is still gated on OQ-16. Each deployed DB must run `db:migrate` (`20261115100000_per_org_screening_criteria`).

A bare `go` is **the next unticked row in `docs/prds/06-backlog.md`**. PRD 09's rows are all done now. Read the backlog's order note for Milestone 19 before you pick.

**Left by R-284:** the request budget is per run, not per minute across runs (a 429 is retried). The budget and deadline have no test.

**Left by R-283:** the real Intuit driver must also implement `listJournalEntries`. With the simulator, the QuickBooks side lives in process memory, so a deployed page can show phantom variance.

**Left by R-282a/b:**
- Deposit disposition never reaches `LedgerEntry`, so Security Deposits Held only grows in QuickBooks.
- Dispute fees are not read.

**Real-Intuit carry-over:** Intuit needs one registered redirect URI, but the callback is built on each org's host. The real driver needs a callback on the platform host that hands back to the org host.

**Local test DB is bloated:** `rental_test` is 3.3 GB with 1.79M `Notification` rows. Under load, notification-heavy files time out in the full run and pass alone. Rebuilding `rental_test` would likely fix it. Ask Shane before dropping it.

**Machine note:** run the unit suite as `npm test -- --maxWorkers=4`. A killed vitest leaves `node (vitest N)` workers alive; kill them by cwd. Pass e2e specs as bare names. A new org-scoped table needs an `org_scope` trigger and an RLS policy. A unit test that crosses orgs wraps the call in `asRequest`. A new server action needs its `actions.manifest.ts` entry, and `unreached` if the fixture cannot reach its own-org path. `cron.spec.ts:59` fails locally and passes in CI. **Check `gh run list --limit 3` after each push.** R-283's red run went unnoticed.

**Carry-overs:** each deployed database must re-run `db:seed` and `db:migrate` (R-291a, R-291b, R-300a, R-300b, R-298a, R-298b, R-287a, R-284, R-297). The real StripeConnector, TwilioProvisioner, ResendProvisioner and VercelDomains still have to be built. `application_fee.refunded` is not handled. OQ-27 is open. The Neon dev branch reports every migration as unapplied.

**Shane owes:** counsel on the reason list (OQ-16). Before org #1 goes live: the neutral domain (D-324) plus wildcard DNS, a certificate and `RESEND_SHARED_FROM`. Before any connected org bills: a Connect endpoint and its secret.
