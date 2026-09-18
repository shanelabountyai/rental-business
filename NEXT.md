# Next session

## Arc 6 is planned. Start R-222.

Milestone 16 ("Arc 6") is rows 209–222 / R-222–R-235 in `docs/prds/06-backlog.md`, sourced from `docs/reviews/2026-09-17-operator-review.md` (D-240). **Read the review's section for the row before touching code** — the file-and-line evidence lives there, not in the row.

**Start here: R-222** — the 03:00 `unit.auto_make_ready` job marks an occupied house vacant on the morning its lease lapses to month-to-month; `lease.mtm_rollover` at 04:00 keeps billing it. Files: `apps/web/lib/units/auto-make-ready.ts`, `apps/web/lib/leases/renewal-rollover-job.ts`. The row's acceptance is one test that runs both jobs against one lease on one business date. **Needs counsel** on the self-help reading; the engineering does not wait for it. No backfill of `moveOutAt`.

Confirm the planning commit's CI with `gh run list --limit 5` rather than trusting this file — it is docs-only, so `paths-ignore` may give it no run at all, which is expected.

## Still open, carried from earlier handoffs

- Deposit-slip and offline-payment flows need proved MFA, which `db:seed:demo-access` cannot mint — `/money/deposits` has never been seen with a batch (R-235's walk).
- No demo rows for `/abandonment/[id]`, `/claims/[id]`, `/confidential/[id]`, `/portal/papers/inspections/[id]`, and no guarantor portal login (R-235).
- Whether a deploy re-runs `db:seed` — unknown, must be answered before go-live (D-240).
- `apps/web/lib/audit/audit-store.test.ts` "oldest-first" is flaky (rows share `occurredAt`).

Everything older is in git history at `b9a353d:NEXT.md` and `e9352b8:NEXT.md`.
