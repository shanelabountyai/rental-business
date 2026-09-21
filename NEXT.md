# Next session

## R-240 is done (`775e3b3`, SHA recorded in `fc43cae`). CI green (`35653603405`).

**First: read CI** with `gh run list --limit 3` and confirm this push's run is the one that shows green (it is, as of this handoff — reconfirm before assuming so days later).

**What R-240 built:** root-caused and fixed `audit-store.test.ts`'s "oldest-first" flake, the second carried defect off R-239's note (backlog row #227). Root cause was findable by reading, no reproduction loop needed: `AuditLog.occurredAt` defaults to Postgres's `CURRENT_TIMESTAMP`, which is stable for a whole transaction — the test's three `recordAudit` calls all run inside one `inRollback` transaction, so all three rows get the **identical** `occurredAt` on every single run, deterministically (not intermittently). `auditTrailFor`'s `orderBy: { occurredAt: 'asc' }` had no secondary key, so which tied row came back first was query-planner-order-dependent: stable in isolation (confirmed 15/15 clean alone on unmodified `main`), exposed to drift only once a full-suite run puts concurrent load on the shared test database. Fix: `auditTrailFor` now sorts `[{ occurredAt: 'asc' }, { id: 'asc' }]` — `id` is a monotonic cuid, so it breaks the tie in true creation order, the same array-`orderBy` tiebreak shape already used throughout `apps/web/lib/**/queries.ts`. Verified 20/20 clean runs after the fix; full `npm test` 3298 passed / 4 skipped, exit 0. Full detail in `docs/PROGRESS.md`'s R-240 entry.

**Milestone 17 (Go-live hardening) now has ZERO scoped rows again.** All three rows scoped so far (R-238, R-239, R-240) are done. Pick the next candidate from `docs/prds/06-backlog.md`'s "Not yet scoped into rows" list (right after the Milestone 17 table) and scope it into a real row before building — do not start coding straight from a one-liner. Candidates, unchanged by R-240:
- A deploy checklist and a real Stripe/Twilio/Resend production-cutover plan (today everything runs against test-mode adapters).
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
