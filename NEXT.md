# Next session

## R-226 is done (`1e9f285`). Start R-227.

**First: read CI** with `gh run list --limit 3`. R-224's run was cancelled when R-225 was pushed on top of it. R-225's and R-226's had not finished when this was written. The last run that finished green was R-223's.

**R-227**: serving a cure notice switches late fees off for the rest of the tenancy, because the `NOTICE_SERVED` hold is never lifted. Row 214 in `docs/prds/06-backlog.md`; review finding 6 in `docs/reviews/2026-09-17-operator-review.md`. It is late-fee correctness, so Opus.

**R-226 left behind** (see its PROGRESS entry and D-245):
- Unchecked: whether the tenant portal's `scope.leaseIds` includes a renewed tenant's ended predecessor, i.e. whether they can still open their original move-in report.
- R-234 is now unblocked.
- R-225's leftovers still stand: no cap check on the month-to-month rollover rate, no tenant message when an increase is withdrawn, and the R-223, R-224 and R-225 migrations are not on the Neon dev branch.

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
