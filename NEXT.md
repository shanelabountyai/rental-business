# Next session

## R-231 is done (`d0eee75`). Start R-232.

**First: read CI** with `gh run list --limit 3`. R-230's run (`35459089141`) was still in progress when R-231 started; R-229's and R-228's are green.

**R-232**: preventive maintenance auto-assigns an uninsured vendor. R-080's recurring job writes `fallbackVendorsForTrade(...)[0]` onto every generated work order (`apps/web/lib/maintenance/preventive-actions.ts:114-127`) with no COI check — R-214's warn-and-log only runs at dispatch, after the work order already carries the vendor. Row 219 in `docs/prds/06-backlog.md`; review finding 11. Fix: skip COI-missing or lapsed vendors when ranking, and raise a Task naming the skip (D-232). Reporting/assignment correctness, not a schema change unless the Task type needs one — Sonnet is enough.

**R-231 left behind:**
- Nothing new. `rent.decide` Tasks still have no special queue rendering (carried from R-229, still unowned).

**Carried from R-229:**
- **Needs a backlog row:** `checkHabitabilityRepairs` in `apps/web/lib/cases/case-stall-job.ts` uses `rulesFor(...).catch(() => null)`. A DB error reads as "no rule", so the job silently flags no habitability deadline. The probable cause of 3 R-217 test failures under full-suite load; they pass alone.

**Carried from R-228:**
- An unserved entry notice needs the override reason, and a hand service recorded later does not re-judge the window. The showing slot list still offers slots for a tenant who cannot be served. **Needs counsel:** damages for entries already made on the old path.

**Carried from R-227:**
- `payment-plan-job.ts` stamps `liftedAt: new Date()` (R-190's class); the suppressed-fee report is only `heldBackCents`.

**Carried from R-226:**
- Whether the portal's `scope.leaseIds` includes a renewed tenant's ended predecessor. R-234 is unblocked.

**Carried from R-225:**
- No cap check on the MTM rollover rate, no tenant message when an increase is withdrawn, and the R-223 to R-227 migrations are not on the Neon dev branch.

**Traps (carried):**
- Run e2e through `npm run test:e2e -- <specs>`, never bare `npx playwright test`. The bare command loads no `.env.test`.
- There is no prettier config. Never run `npx prettier --write`.
- On `/leases/[id]`, "Starts on" and "Money order" are substring traps.
- Orphaned `node (vitest N)` workers survive a `$PWD`-anchored `pkill`. Find them by cwd.
- zsh treats a bare `=====` as a command (`=cmd` expansion). Use `echo '---'` as a separator.

## Still open, carried from earlier handoffs

- Deposit-slip and offline-payment flows need proved MFA, which `db:seed:demo-access` cannot mint — `/money/deposits` has never been seen with a batch (R-235's walk).
- No demo rows for `/abandonment/[id]`, `/claims/[id]`, `/confidential/[id]`, `/portal/papers/inspections/[id]`, and no guarantor portal login (R-235).
- Whether a deploy re-runs `db:seed` — unknown, must be answered before go-live (D-240).
- `apps/web/lib/audit/audit-store.test.ts` "oldest-first" is flaky (rows share `occurredAt`).

Everything older is in git history at `b9a353d:NEXT.md` and `e9352b8:NEXT.md`.
