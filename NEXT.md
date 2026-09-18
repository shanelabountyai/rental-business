# Next session

## R-222 is done (`3ce9299`, SHA recorded in `e4b6a00`). Start R-223.

**First: read CI on `e4b6a00`** with `gh run list --limit 5`. R-222 was pushed without a Playwright run, because no spec reaches the job.

**R-223**: an emergency that comes in by text, email or phone can never page anybody, and staff cannot mark a ticket as an emergency. Row 210 in `docs/prds/06-backlog.md`. Read review finding 2 in `docs/reviews/2026-09-17-operator-review.md` first. Files: `apps/web/lib/maintenance/actions.ts`, `packages/core/maintenance/priority.ts`, `apps/web/lib/maintenance/triage-consumer.ts`. **Needs counsel** is not on this row. **Do not** auto-page on keywords.

**Unit-suite trap seen in R-222:** orphaned `node (vitest N)` workers survive a `pkill -f "$PWD.*vitest"`, because their command line is renamed. They hold `rental_test` connections and caused 20–30s timeouts in unrelated files. Find them by cwd (`lsof -a -p PID -d cwd`) before trusting a timeout.

## Still open, carried from earlier handoffs

- Deposit-slip and offline-payment flows need proved MFA, which `db:seed:demo-access` cannot mint — `/money/deposits` has never been seen with a batch (R-235's walk).
- No demo rows for `/abandonment/[id]`, `/claims/[id]`, `/confidential/[id]`, `/portal/papers/inspections/[id]`, and no guarantor portal login (R-235).
- Whether a deploy re-runs `db:seed` — unknown, must be answered before go-live (D-240).
- `apps/web/lib/audit/audit-store.test.ts` "oldest-first" is flaky (rows share `occurredAt`).

Everything older is in git history at `b9a353d:NEXT.md` and `e9352b8:NEXT.md`.
