# Next session

## Done 2026-10-02: UX-04 (`3f5b33c`). Needs-action row + collected-vs-billed progress bar.

- `dashboard/page.tsx`: new "Needs action today" section (pending approvals, unanswered tenant messages, past-grace tenancies, emergency/urgent tickets — all data already existed in `dashboardSummary`, no new query) rendered first via `actionItems(summary)`, reusing `Tile` with `glow`. Hidden entirely when all four are zero, replaced by "Nothing needs your attention today." Pending approvals and unanswered messages removed from the informational grid below (now live only in the action row). `Tile` gained `progressPct`: a `role="progressbar"` bar on Collected vs billed, red <40%/amber <70%/`bg-primary` otherwise.
- Both design calls (hide-vs-always-show the action row; plain-vs-labeled progress bar) proposed to Shane as clickable previews and approved before writing code — same propose-then-approve step UX-03 used.
- Gate: lint/typecheck/build clean. Scoped e2e (`dashboard.spec.ts`, then `shell.spec.ts`+`route-boundaries.spec.ts`, desktop+mobile): 43 passed + 1 skipped = 44/44 reconciled, including shell's axe sweep (no new violations) and the pending-approvals drill-down test (still passes, now served from the action row).
- **Unit test false alarm, worth remembering**: first `npm test` run (right after the e2e sweep, with event-toolkit's dev server also live) reported 49 failures across 20 unrelated files — timeouts and FK races in cleanup hooks, no shared code path. That's the "wall of failures = environment symptom" signature CLAUDE.md already documents, not a regression (I'd only touched a presentational page). Re-running those 20 files alone once DB connections drained reproduced only the known 4 pre-existing failures. Lesson: don't run a heavy e2e sweep immediately before a full unit sweep on a machine with another project's dev server live — check `pg_stat_activity` before trusting a sudden wall of failures, exactly as the rule says.
- Pushed (`3f5b33c`, SHA backfill `f98ec18`).
- Next in backlog order: **UX-05** (work order/lease list badges: status/priority badge component, sort emergencies first, "New work order" empty-state action). Same design-only shape — propose a preview before building.

## Carried forward, unchanged:

- **OPS-01 still open, deliberately skipped** — go-live readiness list (no live Stripe key, $0 deposit on imported leases, no portal invite for imported tenants, simulated e-sign, daily-cron message delay). Revisit only when going live is actually planned.
- **Shane: subscribe the test webhook endpoint to `charge.dispute.closed`.** Endpoint `we_1U47bfJ7dm36XvZPk4ekxGak` still lists `charge.dispute.created`. Swap it in the Stripe dashboard (Developers → Webhooks), or MONEY-04 never receives its event. Target set in `docs/DEPLOYMENT.md`.
- **Local `rental_test` has leftover data**: up to 4 unit tests fail on `main` too (`comms.test.ts` inbound routing ×2, `pre-move-out-scheduling-job.test.ts` ×2), while CI is green.
- **Production needs migrating**: `20260929120000` (LEGAL-02) and `20260929180000` (LEGAL-03) both pending, via the `docs/DEPLOYMENT.md` recipe. Per-push deploys are off (`bf30ca7`), so a deploy is manual too. UX-03/UX-04 have no migrations.
- **Roll the Stripe TEST secret key**: a masking regex printed it into the 2026-09-28 session transcript. Test mode only, not sent anywhere.
- **Not done, needs Shane:** rotate the demo password (`demo-rental-2026`, tracked in `seed-demo-access.mts` and D-257) — repo is PUBLIC so it's exposed regardless of code fixes. Consider making the repo private too.
- Cost review baseline recorded verbally (2026-09-26) but **not yet written into `07-decisions.md`**: Neon `rentalbusiness` 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel rental-business build CPU $6.76 effective / $1.41 billed for 09-01..09-26. Worth a small follow-up commit.
- Legal review and R-228 still need a person (unchanged).

## Prior: A11Y-01 through A11Y-11, UX-01 through UX-03 all done (see `06-backlog.md` and `PROGRESS.md` for each). 7-agent review sweep scoped 2026-09-27/28 into 37 backlog rows (`90956f0`, `2c30266`). Also done: SEC-17, MONEY-01/02/03/04/06/07/08/09/10, SEC-18, SEC-19, SEC-20, LEGAL-01/02/03/04/05.
