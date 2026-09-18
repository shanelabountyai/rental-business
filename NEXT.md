# Next session

## R-225 is done (`655d2f7`). Start R-226.

**First: read CI** with `gh run list --limit 3`. Neither R-224's run (`35374322666`) nor R-225's had finished when this was written. R-223's was green.

**R-226**: a tenant who renewed has no move-in side to their deposit case. Row 213 in `docs/prds/06-backlog.md`; review finding 5 in `docs/reviews/2026-09-17-operator-review.md`. The fix is one `baselineMoveInFor(leaseId)` that walks `renewedFromLeaseId` back to the first lease, read by `itemsFromMoveIn`, the dispute packet, `deposit-clearing-job.ts`'s warning and `Lease.moveInAt`'s readers. This is deposit and evidence correctness, so Opus.

**R-225 left behind** (see its PROGRESS entry and D-244): no cap check on the MTM rollover rate; the tenant is not told when an increase is withdrawn; the R-223, R-224 and R-225 migrations are not on the Neon dev branch (`db:migrate:dev`).

**Traps seen in R-225:**
- Run e2e through `npm run test:e2e -- <specs>`, never bare `npx playwright test`. The bare command loads no `.env.test`, so every fixture dies with `PrismaClientInitializationError`.
- A lease whose raise was scheduled carries an append-only `Notice`, so any `afterAll` that hard-deletes leases has to treat it as pinned (`leases.spec.ts` shows how).
- On `/leases/[id]`, "Starts on" is a substring of any label containing "starts on". The new field is "Rent increase effective date" for that reason.

**Carried from R-224:**
- There is **no prettier config** in this repo. Never run `npx prettier --write`.
- On `/leases/[id]`, `getByLabel('Money order')` also matches the certified-funds switch. Use `getByText('Money order', { exact: true })`.
- Orphaned `node (vitest N)` workers survive `pkill -f "$PWD.*vitest"`. Find them by cwd (`lsof -a -p PID -d cwd`).

## Still open, carried from earlier handoffs

- Deposit-slip and offline-payment flows need proved MFA, which `db:seed:demo-access` cannot mint — `/money/deposits` has never been seen with a batch (R-235's walk).
- No demo rows for `/abandonment/[id]`, `/claims/[id]`, `/confidential/[id]`, `/portal/papers/inspections/[id]`, and no guarantor portal login (R-235).
- Whether a deploy re-runs `db:seed` — unknown, must be answered before go-live (D-240).
- `apps/web/lib/audit/audit-store.test.ts` "oldest-first" is flaky (rows share `occurredAt`).

Everything older is in git history at `b9a353d:NEXT.md` and `e9352b8:NEXT.md`.
