# Next session

## R-241 is done (`148704f`, SHA recorded in `6fd3b39`). Docs-only push — CI does not run (see below).

**Do not expect a new CI run for this push.** `.github/workflows/ci.yml` has `paths-ignore: ['**.md', 'docs/**']` on both `push` and `pull_request`, and R-241 touched only `docs/DEPLOYMENT.md`, `docs/PROGRESS.md`, `docs/prds/06-backlog.md` and `docs/prds/07-decisions.md`. The last real (code) CI run is still R-240's, `35653603405`, green — `gh run list --limit 3` will correctly show no newer run and that is not a problem to chase.

**What R-241 built:** the deploy checklist + Stripe/Twilio/Resend production-cutover plan, scoped from Milestone 17's "Not yet scoped" list (backlog row #228). Added a "Production cutover" section to `docs/DEPLOYMENT.md` with per-provider steps (precondition, env vars, verification, rollback) for Stripe, Twilio and Resend. **Found along the way:** `DEPLOYMENT.md` had gone stale — it claimed the notification provider "still wires `LoggingChannelAdapter`," but R-104 wired `LiveChannelAdapter` weeks ago. Corrected, with the more important fact spelled out: on this production deployment, with no Resend/Twilio keys set, every email and SMS has been recorded `SUPPRESSED` (not a silently-lost `SENT`) since R-104 shipped — that is `LiveChannelAdapter`'s deliberate production-only refusal, not a bug. Also closed one of D-240's three unknowns as **D-254**: read `vercel-build` directly (`prisma generate && next build`, nothing else) — a deploy never re-runs `db:seed` or a migration. Did **not** touch the Stripe live-key guard (`StripeBillingProvider` refuses `sk_live_`/`rk_live_` at construction by design, D-26) — lifting it needs its own owner-authorized PR at actual cutover time, documented as step 1 of the plan rather than built. Full detail in `docs/PROGRESS.md`'s R-241 entry.

**Milestone 17 (Go-live hardening) still has candidates left, not yet scoped into rows.** Pick the next one from `docs/prds/06-backlog.md`'s "Not yet scoped into rows" list (right after the Milestone 17 table) and scope it into a real row before building — do not start coding straight from a one-liner. Remaining, after R-241 closed the deploy-checklist candidate:
- Legal review of each seeded jurisdiction config as a release gate — a process requirement, not code, but it blocks activating deposit-deadline automation for a real tenancy.
- Whether OQ-6 (screening criteria in writing) and OQ-9 (is Spanish a Must) are still open now that R-060 and the portal shell are built, or were answered along the way and PRD 00's "Flagged gaps & conflicts" section is stale.
- The carried-defects list below.

**Carried defects (unowned, still true):**
- No GUARANTOR notification-preferences screen exists at all (D-252), though GUARANTOR is a real audience for `rent_reminder`, `payment_plan`, `lease_signature`, `account_access`.
- `plan-esign.ts` hardcodes TENANT for a payment-plan signature invite even though a `LeaseSigner` could in principle be a guarantor.
- `/money/deposits` has never shown a batch in the demo — needs a real open Stripe invoice or a simulator run.
- Demo seed writes a future `moveOutAt` on two ACTIVE leases, a state the product cannot produce (harmless today).
- Unserved entry notice + later hand service does not re-judge the window; needs counsel on damages for entries already made (R-228).
- `payment-plan-job.ts` / suppressed-fee report gap (R-227).
- No MTM rollover rate cap, no withdrawn-increase tenant message, R-223-R-233 migrations not on the Neon dev branch (R-225).
- Whether a deploy re-runs `db:seed` is unknown (D-240) — must be answered before go-live.
- No demo rows for `/abandonment/[id]`, `/claims/[id]`, `/confidential/[id]`, `/portal/papers/inspections/[id]`.
- **The vitest suite has no shared `uniqueStateCode()`-equivalent helper.** Every job/unit test file that needs a `JurisdictionRule` picks its own hardcoded 2-letter state code and tracks collisions by a manually maintained comment list (TX/ZZ/XY/ZY/XW/NY/YQ, and until R-239, QZ). Not yet a real fix — worth one (a shared helper in a vitest test-utils module) only if a second file ever shows the same flake; none has.

**Traps (carried):**
- Run e2e through `npm run test:e2e -- <specs>`, never bare `npx playwright test`.
- There is no prettier config. Never run `npx prettier --write`.
- On `/leases/[id]`, "Starts on" and "Money order" are substring traps.
- zsh treats a bare `=====` as a command (`=cmd` expansion). Use `echo '---'` as a separator.
- **zsh also treats `status` as a read-only variable name** — this bit a Monitor script directly in R-240's own session (`(eval):3: read-only variable: status`, exit 1, not a CI failure). Name any Monitor/loop script variable something else (`run_status`, etc.) — do not reuse this on faith, it was hit again after already being written down once.
- A CI e2e failure on notification-confirmation text during evening hours is very likely the quiet-hours issue R-237 already fixed for 5 files — if it recurs somewhere else, extend `safeTimeZone()`'s usage rather than re-diagnosing from scratch.
- **Never `vi.spyOn` a method on the shared `prisma` client singleton in a test** (R-238). It leaves that method permanently `undefined` for every later test in the same file, even through `vi.restoreAllMocks()` in `afterEach`. To simulate a real DB error, manually save the original function, reassign it, and restore it yourself in a `try/finally` (see `apps/web/lib/jurisdiction/queries.test.ts`'s `rulesForConfigured` describe block for the pattern).
- **A fixed literal used as a `JurisdictionRule.state` (or any nullable-jurisdiction fixture key) in a vitest integration test is not actually isolated, even with a comment claiming so** (R-239). A crashed/killed run leaves its row behind forever (only `afterAll` cleans it, and `afterAll` never runs if the process dies mid-suite). Postgres's nullable `jurisdiction` column means the unique constraint does not stop a duplicate. Use a randomly generated state code, never a fixed literal — see `case-stall-job.test.ts`'s `STATE` constant, or `e2e/fixtures.ts`'s `uniqueStateCode()`.
- **A Prisma `findMany` with no tiebreaker in its `orderBy` is not actually deterministic when rows can tie on the sorted column** (R-239's `effectiveFrom` case, R-240's `occurredAt` case — two different tables, same shape). Postgres's `CURRENT_TIMESTAMP`/`now()` is stable for an entire transaction, so any table whose default is one of those and whose rows are written inside one transaction will tie exactly, every time, not intermittently — check for a secondary sort key (usually `id`) before trusting an `orderBy` on a timestamp column that a transaction could have written more than one row under.
- **`npm test`'s exit code is trustworthy as of R-239/R-240** — both known flakes (`case-stall-job.test.ts`, `audit-store.test.ts`) are fixed. If a full run still goes red for an unrelated reason, it is a new problem, not either of these.

Everything older is in git history at `775e3b3:NEXT.md` (R-239's handoff), `32e65e0:NEXT.md`, `26b7e0c:NEXT.md`, `b9a353d:NEXT.md`, `e9352b8:NEXT.md` and `11a7d81:NEXT.md`.
