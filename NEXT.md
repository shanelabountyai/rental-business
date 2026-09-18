# Next session

## R-224 is done (`5df46c0`). Start R-225.

**First: read CI** with `gh run list --limit 3`. R-224's run had not been read when this was written. R-223's (`35371468362`) was green.

**R-225**: a rent increase typed on the lease edit form reaches Stripe with no notice period, no cap check and no notice document. Row 212 in `docs/prds/06-backlog.md`; review finding 4 in `docs/reviews/2026-09-17-operator-review.md`. Statute-driven money path, so Opus.

**R-224 left behind** (see its PROGRESS entry): a deposit disposition whose pushes stop part-way cannot resume; days-past-due does not read the per-invoice list yet; the R-223 and R-224 migrations are not on the Neon dev branch (`db:migrate:dev`).

**Traps seen in R-224:**
- There is **no prettier config** in this repo. `npx prettier --write` reformats to defaults (double quotes, semicolons). Never run it.
- On `/leases/[id]`, `getByLabel('Money order')` also matches the certified-funds switch. Press `getByText('Money order', { exact: true })`, because the radio is `sr-only` and its label takes the press.

**Unit-suite trap seen in R-222:** orphaned `node (vitest N)` workers survive a `pkill -f "$PWD.*vitest"`, because their command line is renamed. Find them by cwd (`lsof -a -p PID -d cwd`) before trusting a timeout.

## Still open, carried from earlier handoffs

- Deposit-slip and offline-payment flows need proved MFA, which `db:seed:demo-access` cannot mint — `/money/deposits` has never been seen with a batch (R-235's walk).
- No demo rows for `/abandonment/[id]`, `/claims/[id]`, `/confidential/[id]`, `/portal/papers/inspections/[id]`, and no guarantor portal login (R-235).
- Whether a deploy re-runs `db:seed` — unknown, must be answered before go-live (D-240).
- `apps/web/lib/audit/audit-store.test.ts` "oldest-first" is flaky (rows share `occurredAt`).

Everything older is in git history at `b9a353d:NEXT.md` and `e9352b8:NEXT.md`.
