# Next session

## R-236 is done (`75de1b5`). THE NUMBERED BACKLOG IS EMPTY.

**First: read CI** with `gh run list --limit 3` and confirm R-236's push run went green.

`docs/prds/06-backlog.md` has no `⬜` or `🟡` rows left — every item from R-1 through R-236, across all 16 milestones (Foundation through Arc 6), is `✅`. This is the first time that has been true. There is no "next item" to hand off; the session that opens this needs a direction from Shane before picking up tools, not a `go`.

**What's actually left**, none of it a queued backlog row:

1. **Three unresolved owner questions at the bottom of `06-backlog.md`** ("Flagged gaps & conflicts", items 4-6): screening criteria must exist in writing before OQ-6 is truly closed (check whether R-060's build already covers this or the question is still live); OQ-9 (is Spanish a Must, not Phase 3?); legal review of each jurisdiction config as a release gate (R-071/R-010) — a process requirement, not code.
2. **Carried defects, none owned**, accumulated across the last several items (full detail in git history's prior `NEXT.md` versions and each item's own `PROGRESS.md` "what it left behind"):
   - `/money/deposits` has never shown a batch in the demo (needs a real open Stripe invoice or a simulator run).
   - No GUARANTOR notification-preferences screen exists at all (R-236/D-252) even though GUARANTOR is a real audience for four categories.
   - `plan-esign.ts` hardcodes TENANT for a payment-plan signature invite even though a `LeaseSigner` could be a guarantor (flagged during R-236's audience sweep, not fixed).
   - `checkHabitabilityRepairs` swallows a DB error as "no rule" (R-229).
   - Unserved entry notice + later hand service does not re-judge the window (R-228); needs counsel on damages for entries already made.
   - `payment-plan-job.ts` / suppressed-fee report gap (R-227).
   - No MTM rollover rate cap, no withdrawn-increase tenant message, R-223–R-233 migrations not on the Neon dev branch (R-225).
   - Demo seed writes a future `moveOutAt` on two ACTIVE leases, a state the product cannot produce (harmless today, R-235).
   - Whether a deploy re-runs `db:seed` is unknown (D-240) — must be answered before go-live.
   - No demo rows for `/abandonment/[id]`, `/claims/[id]`, `/confidential/[id]`, `/portal/papers/inspections/[id]`.
   - `apps/web/lib/audit/audit-store.test.ts` "oldest-first" is flaky (rows share `occurredAt`).
3. **8 e2e specs are wall-clock-dependent on Central quiet hours** (found this session, not fixed): `golden-path-5`, `inspections` (R-157), `payment-plans`, `screening`, `rent-roll` (×4) all assert an immediate "sent" confirmation with no clock control, and fail if CI runs 21:00-08:00 Central. Real, will recur. Worth its own item (inject a controllable clock, or pick fixture times outside the window) if it fires again.
4. **Go-live readiness generally** hasn't been scoped as backlog rows: deploy checklist, a real production Stripe/Twilio/Resend cutover plan, jurisdiction-rule legal sign-off (item 6 above), and whatever the owner wants for a beta.

**The actual next step is a conversation with Shane, not a `go`:** is this backlog reopened with a new arc of items (what kind — more defect-hunting, or new features), or does the project move to go-live hardening (the four things above), or is v1 considered feature-complete and paused? Ask before starting work.

**Traps (carried, still true):**
- Run e2e through `npm run test:e2e -- <specs>`, never bare `npx playwright test`.
- There is no prettier config. Never run `npx prettier --write`.
- On `/leases/[id]`, "Starts on" and "Money order" are substring traps.
- zsh treats a bare `=====` as a command (`=cmd` expansion). Use `echo '---'` as a separator.
- A CI run that fails only on notification-confirmation text during evening hours is very likely the quiet-hours clock issue above, not a regression — check the wall-clock time of the run before assuming code broke.

Everything older is in git history at `b9a353d:NEXT.md`, `e9352b8:NEXT.md` and `11a7d81:NEXT.md`.
