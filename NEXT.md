# Next session

## R-228 is done (`4f93663`). Start R-229.

**First: read CI** with `gh run list --limit 3`. R-228 was pushed only after R-227's run `35377407186` finished, so both runs should be complete.

**R-229**: the chase ladder speaks three times in a tenancy's first arrears episode and never again. Row 216 in `docs/prds/06-backlog.md`; review finding 8. It is money- and collections-critical, so Opus. **Not** a settings screen for `CHASE_LADDER_DAYS`.

**R-228 left behind** (see its PROGRESS entry and D-247):
- An unserved entry notice now needs the override reason. Recording hand service on `/notices` later does not re-judge the window.
- A self-serve showing is refused at submit when the tenant cannot be served, but the slot list still offers slots.
- **Needs counsel:** damages for entries already made on the old path. There is no backfill or report of them.
- Carried from R-227: `payment-plan-job.ts` stamps `liftedAt: new Date()` (R-190's class); the suppressed-fee report is only `heldBackCents`.
- Carried from R-226: whether the portal's `scope.leaseIds` includes a renewed tenant's ended predecessor. R-234 is unblocked.
- Carried from R-225: no cap check on the MTM rollover rate, no tenant message when an increase is withdrawn, and the R-223 to R-227 migrations are not on the Neon dev branch.

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
