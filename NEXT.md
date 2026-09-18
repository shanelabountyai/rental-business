# Next session

## R-227 is done (`d325095`). Start R-228.

**First: read CI** with `gh run list --limit 3`. R-227's push cancelled R-226's run (still in progress at 25 min), so R-227's run is the first to cover R-224 to R-227. The last green run is R-223's.

**R-228**: an entry is judged as if its notice were served this instant, and preventive work enters occupied houses with no notice. Row 215 in `docs/prds/06-backlog.md`; review finding 7. It is correctness-critical and Needs counsel, so Opus.

**R-227 left behind** (see its PROGRESS entry and D-246):
- The held days of EVERY fee-stopping hold are now never charged (`lateFeeOutsideHolds`), not only `notice_served`'s. That is a behaviour change for bankruptcy, SCRA and payment-plan holds, and it is recorded in D-246.
- The suppressed-fee report is only the job record's `heldBackCents`, a nightly snapshot. There is no screen for it.
- `payment-plan-job.ts` stamps `liftedAt: new Date()` instead of the job's `now` (R-190's class).
- Still open from R-226: whether the portal's `scope.leaseIds` includes a renewed tenant's ended predecessor. R-234 is unblocked.
- Still open from R-225: no cap check on the MTM rollover rate, no tenant message when an increase is withdrawn, and the R-223 to R-227 migrations are not on the Neon dev branch.

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
