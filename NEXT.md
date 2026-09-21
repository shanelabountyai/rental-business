# Next session

## R-237 is done (`470348d`, SHA recorded in `df0e8c4`). CI green (`35615475444`). Milestone 17's only scoped row is now closed.

**First: read CI** with `gh run list --limit 3` and confirm this push's run is the one that shows green (it is, as of this handoff — reconfirm before assuming so days later).

**What R-237 built:** `safeTimeZone()` in `e2e/fixtures.ts` — picks an `Etc/GMT` offset where "right now" is outside the product's 21:00-08:00 quiet hours, instead of the five specs' hardcoded `timezone: 'America/Chicago'`. `rent-roll.spec.ts`'s `daysAgo`/`finalizedAt` now read a single module-level `const ZONE` so the property and the date-math fixtures never disagree. Verified locally: `PORT=3100 npm run test:e2e -- e2e/golden-path-5.spec.ts e2e/inspections.spec.ts e2e/payment-plans.spec.ts e2e/screening.spec.ts e2e/rent-roll.spec.ts` — **58 passed**, matching `--list`. Full detail in `docs/PROGRESS.md`'s R-237 entry.

**Milestone 17 (Go-live hardening) now has ZERO scoped rows.** `docs/prds/06-backlog.md`'s "Not yet scoped into rows" list (right after the Milestone 17 table) is what the next session picks from and scopes into a real row before building — do not start coding straight from that list's one-liners. Candidates, unchanged since R-236:
- A deploy checklist and a real Stripe/Twilio/Resend production-cutover plan (today everything runs against test-mode adapters).
- Legal review of each seeded jurisdiction config as a release gate — a process requirement, not code, but it blocks activating deposit-deadline automation for a real tenancy.
- Whether OQ-6 (screening criteria in writing) and OQ-9 (is Spanish a Must) are still open now that R-060 and the portal shell are built, or were answered along the way and PRD 00's "Flagged gaps & conflicts" section is stale.
- The carried-defects list below — each is a candidate row, not yet sized or ordered.

**Carried defects (unowned, still true):**
- No GUARANTOR notification-preferences screen exists at all (D-252), though GUARANTOR is a real audience for `rent_reminder`, `payment_plan`, `lease_signature`, `account_access`.
- `plan-esign.ts` hardcodes TENANT for a payment-plan signature invite even though a `LeaseSigner` could in principle be a guarantor.
- `/money/deposits` has never shown a batch in the demo — needs a real open Stripe invoice or a simulator run.
- Demo seed writes a future `moveOutAt` on two ACTIVE leases, a state the product cannot produce (harmless today).
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
- **zsh also treats `status` as a read-only variable name** — a Monitor/loop script that assigns to a var called `status` dies with "read-only variable: status" on this machine. Name it something else (`run_status`, etc.). Hit this writing R-237's own CI-watch monitor.
- A CI e2e failure on notification-confirmation text during evening hours is very likely the quiet-hours issue R-237 already fixed for these 5 files — if it recurs somewhere else, extend `safeTimeZone()`'s usage rather than re-diagnosing from scratch.

Everything older is in git history at `b9a353d:NEXT.md`, `e9352b8:NEXT.md`, `11a7d81:NEXT.md` and `7fa848e:NEXT.md`.
