# Next session

## R-223 is done (`deb9357`, SHA recorded in `dfb66c6`). Start R-224.

**First: read CI** with `gh run list --limit 5`. When R-223 was pushed, R-222's run (`35369885736`) was still in progress and R-223's (`35371468362`) was queued. Neither had been read.

**R-224**: in live mode a tenant cannot cure a pay-or-quit at the counter. Row 211 in `docs/prds/06-backlog.md`; review finding 3 in `docs/reviews/2026-09-17-operator-review.md`. Money path, so Opus.

**R-223 left behind** (see its PROGRESS entry): no shutoff reply to a texted emergency, and no row owns it; no suggestion on phone-logged tickets or on later threaded messages; the new migration is not on the Neon dev branch yet (`db:migrate:dev`).

**Unit-suite trap seen in R-222:** orphaned `node (vitest N)` workers survive a `pkill -f "$PWD.*vitest"`, because their command line is renamed. Find them by cwd (`lsof -a -p PID -d cwd`) before trusting a timeout.

## Still open, carried from earlier handoffs

- Deposit-slip and offline-payment flows need proved MFA, which `db:seed:demo-access` cannot mint — `/money/deposits` has never been seen with a batch (R-235's walk).
- No demo rows for `/abandonment/[id]`, `/claims/[id]`, `/confidential/[id]`, `/portal/papers/inspections/[id]`, and no guarantor portal login (R-235).
- Whether a deploy re-runs `db:seed` — unknown, must be answered before go-live (D-240).
- `apps/web/lib/audit/audit-store.test.ts` "oldest-first" is flaky (rows share `occurredAt`).

Everything older is in git history at `b9a353d:NEXT.md` and `e9352b8:NEXT.md`.
