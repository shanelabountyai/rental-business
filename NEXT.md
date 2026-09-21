# Next session

## R-238 is done (`f84bc37`, SHA recorded in `7fe8494`). CI green (`35626500507`).

**First: read CI** with `gh run list --limit 3` and confirm this push's run is the one that shows green (it is, as of this handoff — reconfirm before assuming so days later).

**What R-238 built:** a shared `rulesForConfigured(property, asOf)` helper beside `rulesFor` in `apps/web/lib/jurisdiction/queries.ts` — catches only `JurisdictionRuleNotFoundError`, rethrows everything else. Swapped onto it: **29 call sites across 23 files**, every one of which used to catch a real database error the same way it caught "state not configured" (`.catch(() => null)` or an equivalent bare `try/catch`), so a transient DB failure under load silently skipped fee assessment, habitability escalation, deposit deadlines and eviction cure clocks instead of failing the job. Two sites (`evictions/queries.ts` ×2, `notice-hold-lift.ts`) needed their `try` blocks restructured rather than a mechanical swap. Full detail and the exact file list in `docs/PROGRESS.md`'s R-238 entry; the row itself is backlog #225.

**Milestone 17 (Go-live hardening) now has ZERO scoped rows again.** Pick the next candidate from `docs/prds/06-backlog.md`'s "Not yet scoped into rows" list (right after the Milestone 17 table) and scope it into a real row before building — do not start coding straight from a one-liner. Candidates, updated by R-238:
- A deploy checklist and a real Stripe/Twilio/Resend production-cutover plan (today everything runs against test-mode adapters).
- Legal review of each seeded jurisdiction config as a release gate — a process requirement, not code, but it blocks activating deposit-deadline automation for a real tenancy.
- Whether OQ-6 (screening criteria in writing) and OQ-9 (is Spanish a Must) are still open now that R-060 and the portal shell are built, or were answered along the way and PRD 00's "Flagged gaps & conflicts" section is stale.
- **NEW, and probably the strongest next pick: `case-stall-job.test.ts`'s three R-217 habitability tests are a genuine pre-existing flake**, reconfirmed while verifying R-238's own fix. They fail in isolation (reproduced on unmodified `main` via `git stash`) and fail on some full-suite runs while passing on others — same three tests every time. The failure is wrong *data* (`taskFor(...)` resolves `undefined`/`null` where a Task is expected), not a thrown error, which rules out R-238's DB-error-swallowing bug class as the cause. Root cause unknown. Worth investigating soon since it undermines trust in the gate (`npm test` exit code varies run to run on an unchanged tree).
- The rest of the carried-defects list below.

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
- `apps/web/lib/audit/audit-store.test.ts` "oldest-first" is flaky (rows share `occurredAt`) — a second, distinct pre-existing flaky test, not investigated by R-238.

**Traps (carried):**
- Run e2e through `npm run test:e2e -- <specs>`, never bare `npx playwright test`.
- There is no prettier config. Never run `npx prettier --write`.
- On `/leases/[id]`, "Starts on" and "Money order" are substring traps.
- zsh treats a bare `=====` as a command (`=cmd` expansion). Use `echo '---'` as a separator.
- zsh also treats `status` as a read-only variable name — name a Monitor/loop script variable something else (`run_status`, etc.).
- A CI e2e failure on notification-confirmation text during evening hours is very likely the quiet-hours issue R-237 already fixed for 5 files — if it recurs somewhere else, extend `safeTimeZone()`'s usage rather than re-diagnosing from scratch.
- **New from R-238: never `vi.spyOn` a method on the shared `prisma` client singleton in a test.** It leaves that method permanently `undefined` for every later test in the same file, even through `vi.restoreAllMocks()` in `afterEach` — reproduced twice on `prisma.jurisdictionRule.findMany`. To simulate a real DB error, manually save the original function, reassign it, and restore it yourself in a `try/finally` (see `apps/web/lib/jurisdiction/queries.test.ts`'s `rulesForConfigured` describe block for the pattern).
- **New from R-238: `npm test`'s exit code is not fully trustworthy right now** — the `case-stall-job.test.ts` flake above makes the full sweep pass or fail on an unchanged tree depending on scheduling. If a full run goes red, check whether the only failures are those three named tests before assuming a regression; if they are, it's the known flake, not your change.

Everything older is in git history at `26b7e0c:NEXT.md`, `b9a353d:NEXT.md`, `e9352b8:NEXT.md` and `11a7d81:NEXT.md`.
