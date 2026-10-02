# Next session

## Done 2026-10-02: UX-05 (`3933584`). Work order list priority/status badges.

- `workorders/page.tsx`: added `PriorityBadge` (colored pill — red EMERGENCY, amber URGENT, muted ROUTINE) and `StatusBadge` (plain pill, `WORK_ORDER_STATUS_LABELS`), replacing plain-text priority/status in the row metadata line, alongside the existing Warranty pill.
- Shane approved "colored priority, plain status" over "color both" via a clickable preview — status colors deliberately deferred to UX-06 (real semantic tokens), so this item doesn't pick colors that get reworked next.
- The backlog row's other two asks were already done by earlier items, no code needed: emergencies already sort first (R-076), and the empty state already sits below an unconditional "New work order" header button (R-024).
- Gate: lint/typecheck/build clean. Scoped e2e (`workorders.spec.ts`, desktop+mobile): 18/18 passed, reconciled, including the accessibility sweep (no new violations).
- **Unit test false alarm, same signature as UX-04's**: first `npm test` reported 35 failures across 21 unrelated files. `pg_stat_activity` showed `event_toolkit_dev` holding 26 connections and `bookable_test` 8 at the time — other projects' processes, not this change. Re-running the 21 files alone (correctly, via `dotenv -e .env.test -e .env.local -- vitest run <files>` — a bare `npx vitest run` skips env loading and 404s on `DATABASE_URL`) reproduced only the 4 already-documented pre-existing failures. No regression.
- Pushed (`3933584`, SHA backfill `34b8d11`).
- Next in backlog order: **UX-06** (`--success`/`--warning`/`--danger` CSS tokens + one `<Badge tone>` component — the real fix for the ad hoc amber/red/green/emerald/blue colors used directly in 20+ places, including the badges UX-04/UX-05 just added). Same design-only shape — propose a preview before building; this one has more surface area than UX-04/05 since it touches an actual shared component other pages should migrate to.

## Carried forward, unchanged:

- **OPS-01 still open, deliberately skipped** — go-live readiness list (no live Stripe key, $0 deposit on imported leases, no portal invite for imported tenants, simulated e-sign, daily-cron message delay). Revisit only when going live is actually planned.
- **Shane: subscribe the test webhook endpoint to `charge.dispute.closed`.** Endpoint `we_1U47bfJ7dm36XvZPk4ekxGak` still lists `charge.dispute.created`. Swap it in the Stripe dashboard (Developers → Webhooks), or MONEY-04 never receives its event. Target set in `docs/DEPLOYMENT.md`.
- **Local `rental_test` has leftover data**: up to 4 unit tests fail on `main` too (`comms.test.ts` inbound routing ×2, `pre-move-out-scheduling-job.test.ts` ×2), while CI is green.
- **Production needs migrating**: `20260929120000` (LEGAL-02) and `20260929180000` (LEGAL-03) both pending, via the `docs/DEPLOYMENT.md` recipe. Per-push deploys are off (`bf30ca7`), so a deploy is manual too. UX-03/04/05 have no migrations.
- **Roll the Stripe TEST secret key**: a masking regex printed it into the 2026-09-28 session transcript. Test mode only, not sent anywhere.
- **Not done, needs Shane:** rotate the demo password (`demo-rental-2026`, tracked in `seed-demo-access.mts` and D-257) — repo is PUBLIC so it's exposed regardless of code fixes. Consider making the repo private too.
- Cost review baseline recorded verbally (2026-09-26) but **not yet written into `07-decisions.md`**: Neon `rentalbusiness` 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel rental-business build CPU $6.76 effective / $1.41 billed for 09-01..09-26. Worth a small follow-up commit.
- Legal review and R-228 still need a person (unchanged).
- **Other projects' dev servers were live during this session** (`event_toolkit_dev` 26 connections, `bookable_test` 8) — not this repo's problem to fix, but if a future unit-test run here shows a wide, unrelated wall of failures, check `pg_stat_activity` before touching app code, same as this item and UX-04 both hit.

## Prior: A11Y-01 through A11Y-11, UX-01 through UX-04 all done (see `06-backlog.md` and `PROGRESS.md` for each). 7-agent review sweep scoped 2026-09-27/28 into 37 backlog rows (`90956f0`, `2c30266`). Also done: SEC-17, MONEY-01/02/03/04/06/07/08/09/10, SEC-18, SEC-19, SEC-20, LEGAL-01/02/03/04/05.
