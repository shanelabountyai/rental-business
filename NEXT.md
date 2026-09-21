# Next session

## R-239 is done (`16059c5`, SHA recorded in `e23145d`). Push landed; CI not yet confirmed for this push.

**First: read CI** with `gh run list --limit 3` and confirm this push's run (top of the list, commit `e23145d` or `16059c5`) is the one that shows green — this handoff was written right after the push, before that run finished.

**What R-239 built:** root-caused and fixed the `case-stall-job.test.ts` R-217 habitability flake R-238 found and carried. Reproduced it in a loop (~1-in-3 failures running the file alone), then instrumented `checkHabitabilityRepairs` to print the rule it resolved. Found a **leftover `JurisdictionRule` row for state `QZ`** (`habitabilityRepairDays: null`) orphaned in `rental_test` by some past run that never reached its own `afterAll` — it tied with the test's own fresh fixture on `(state, jurisdiction=null, effectiveFrom=2020-01-01)`, so the nullable-jurisdiction unique-constraint gap `CLAUDE.md` already documents let both rows coexist, and `rulesFor`'s `findMany` has no `ORDER BY` — so which of the two tied rows `selectApplicableRule` picked was query-planner-order-dependent, not stable across runs. Fix: swapped the test's fixed `STATE = 'QZ'` literal for `` `Q${randomUUID().slice(0, 8)}` `` — genuinely unique per run, mirroring `e2e/fixtures.ts`'s `uniqueStateCode()`, which already exists for this exact bug class. Deleted the one orphaned row as immediate cleanup. Verified 10/10 clean runs after the fix; full `npm test` 3298 passed / 4 skipped, exit 0. Backlog row #226; full detail in `docs/PROGRESS.md`'s R-239 entry.

**Milestone 17 (Go-live hardening) now has ZERO scoped rows again.** Both rows that were scoped (R-238, R-239) are done. Pick the next candidate from `docs/prds/06-backlog.md`'s "Not yet scoped into rows" list (right after the Milestone 17 table) and scope it into a real row before building — do not start coding straight from a one-liner. Candidates, unchanged by R-239:
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
- `apps/web/lib/audit/audit-store.test.ts` "oldest-first" is flaky (rows share `occurredAt`) — a second, distinct pre-existing flaky test, unrelated to R-239's fix, not yet investigated.
- **The vitest suite has no shared `uniqueStateCode()`-equivalent helper.** Every job/unit test file that needs a `JurisdictionRule` picks its own hardcoded 2-letter state code and tracks collisions by a manually maintained comment list (TX/ZZ/XY/ZY/XW/NY/YQ, and until R-239, QZ). R-239 fixed the one file that was actually showing symptoms; it did not sweep the others, since a fixed literal only causes a problem if an orphaned row for that exact code happens to exist. Worth a real fix (a shared helper in a vitest test-utils module) if a second file ever shows the same flake.

**Traps (carried):**
- Run e2e through `npm run test:e2e -- <specs>`, never bare `npx playwright test`.
- There is no prettier config. Never run `npx prettier --write`.
- On `/leases/[id]`, "Starts on" and "Money order" are substring traps.
- zsh treats a bare `=====` as a command (`=cmd` expansion). Use `echo '---'` as a separator.
- zsh also treats `status` as a read-only variable name — name a Monitor/loop script variable something else (`run_status`, etc.).
- A CI e2e failure on notification-confirmation text during evening hours is very likely the quiet-hours issue R-237 already fixed for 5 files — if it recurs somewhere else, extend `safeTimeZone()`'s usage rather than re-diagnosing from scratch.
- **Never `vi.spyOn` a method on the shared `prisma` client singleton in a test** (R-238). It leaves that method permanently `undefined` for every later test in the same file, even through `vi.restoreAllMocks()` in `afterEach`. To simulate a real DB error, manually save the original function, reassign it, and restore it yourself in a `try/finally` (see `apps/web/lib/jurisdiction/queries.test.ts`'s `rulesForConfigured` describe block for the pattern).
- **New from R-239: a fixed literal used as a `JurisdictionRule.state` (or any nullable-jurisdiction fixture key) in a vitest integration test is not actually isolated, even with a comment claiming so.** A crashed/killed run leaves its row behind forever (only `afterAll` cleans it, and `afterAll` never runs if the process dies mid-suite — jetsam, ctrl-C, a CI abort). The nullable `jurisdiction` column means Postgres's unique constraint does not stop a duplicate, and an unordered `findMany` plus `selectApplicableRule`'s strictly-greater tie-break means which row wins is query-planner-dependent — a silent, intermittent "wrong data" flake, not a thrown error. If a test needs its own `JurisdictionRule`, use a randomly generated state code, never a fixed literal — see `case-stall-job.test.ts`'s `STATE` constant for the pattern, or `e2e/fixtures.ts`'s `uniqueStateCode()` for the e2e-side original.
- **`npm test`'s exit code should be trustworthy again as of R-239** — the `case-stall-job.test.ts` flake that made a full sweep pass or fail on an unchanged tree is fixed. If a full run still goes red for an unrelated reason, it is a new problem, not this one.

Everything older is in git history at `32e65e0:NEXT.md`, `26b7e0c:NEXT.md`, `b9a353d:NEXT.md`, `e9352b8:NEXT.md` and `11a7d81:NEXT.md`.
