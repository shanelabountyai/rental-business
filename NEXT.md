# Next session

## R-236 is done (`75de1b5`). Backlog reopened as Milestone 17: Go-live hardening. Start R-237.

**First: read CI** with `gh run list --limit 3` and confirm R-236's push run went green.

**Direction (D-253):** Shane chose go-live hardening over a new feature arc or a pause, once R-236 closed the last row of the original 16-milestone backlog. `docs/prds/06-backlog.md` now has a **Milestone 17: Go-live hardening** section with one scoped row (below) and a list of not-yet-scoped candidates (deploy checklist, production Stripe/Twilio/Resend cutover, jurisdiction-config legal review, whether OQ-6/OQ-9 are still open, the carried-defects backlog) — read that section before assuming there's nothing after R-237.

**R-237**: 8 e2e specs (`golden-path-5.spec.ts:138`, `inspections.spec.ts:636`, `payment-plans.spec.ts:133`, `screening.spec.ts:268`, and 4 in `rent-roll.spec.ts`) assert an immediate "sent"/"told" confirmation with no control over the wall clock, so they fail for real if the suite runs inside the property's 21:00-08:00 Central quiet hours — confirmed this session when R-235's CI push landed at 22:59 Central and 16 tests (8 specs × 2 browser projects) failed identically, then passed on an identical rerun after 08:00 with zero code changes. Fix is a fixture-level clock pin or a per-test quiet-hours override, written once in `e2e/fixtures.ts` — not a change to the product's quiet-hours behavior, which is correct. Full backlog row has the file:line list. Size S–M. Mechanical once the fixture shape is picked — **Sonnet** is fine.

**R-236 left behind:**
- No GUARANTOR notification-preferences screen exists at all (D-252), though GUARANTOR is a real audience for `rent_reminder`, `payment_plan`, `lease_signature`, `account_access`.
- `plan-esign.ts` hardcodes TENANT for a payment-plan signature invite even though a `LeaseSigner` could in principle be a guarantor — found during the audience-mapping sweep, not fixed. Worth a second look if a guarantor is ever found unable to sign a payment plan.

**Carried from R-235:**
- `/money/deposits` has never shown a batch in the demo — needs a real open Stripe invoice or a simulator run.
- Demo seed writes a future `moveOutAt` on two ACTIVE leases, a state the product cannot produce (harmless today).

**Carried from R-229/R-228/R-227/R-225 (still unowned, still true — see git history's prior `NEXT.md`s for full text):**
- `checkHabitabilityRepairs` swallows a DB error as "no rule" (R-229).
- Unserved entry notice + later hand service does not re-judge the window; needs counsel on damages for entries already made (R-228).
- `payment-plan-job.ts` / suppressed-fee report gap (R-227).
- No MTM rollover rate cap, no withdrawn-increase tenant message, R-223-R-233 migrations not on the Neon dev branch (R-225).
- Whether a deploy re-runs `db:seed` is unknown (D-240) — must be answered before go-live.
- No demo rows for `/abandonment/[id]`, `/claims/[id]`, `/confidential/[id]`, `/portal/papers/inspections/[id]`.
- `apps/web/lib/audit/audit-store.test.ts` "oldest-first" is flaky (rows share `occurredAt`).

**Traps (carried):**
- Run e2e through `npm run test:e2e -- <specs>`, never bare `npx playwright test`.
- There is no prettier config. Never run `npx prettier --write`.
- On `/leases/[id]`, "Starts on" and "Money order" are substring traps.
- zsh treats a bare `=====` as a command (`=cmd` expansion). Use `echo '---'` as a separator.
- A CI e2e failure on notification-confirmation text during evening hours is very likely the quiet-hours issue R-237 exists to fix, not a regression — check the wall-clock time of the run before assuming code broke.

Everything older is in git history at `b9a353d:NEXT.md`, `e9352b8:NEXT.md` and `11a7d81:NEXT.md`.
