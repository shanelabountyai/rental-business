# Next session

## Done 2026-10-02: UX-03 (`11d254c`). Nav grouping + breadcrumbs.

- `NavItem` (`lib/nav.ts`) gained `group: NavGroup` (`Daily`/`Money`/`Property`/`Compliance`/`Admin`), assigned to all 27 nav items. Proposed to Shane as a clickable grouping preview, approved as-is before any code was written. `Nav` (`components/shell/nav.tsx`) renders one `<h2>`-headed list per non-empty group instead of a flat `<ul>`.
- New `Breadcrumbs` (`components/shell/breadcrumbs.tsx`) wired into `/properties/[id]`, `/leases/[id]` (replacing its "← All leases" link), `/workorders/[id]` (replacing its ad hoc property-name link).
- Gate: lint/typecheck/build clean. Unit: same 4 pre-existing unrelated failures. Scoped e2e (`shell.spec.ts`+`portal.spec.ts`+`route-boundaries.spec.ts`+`properties.spec.ts`+`leases.spec.ts`+`workorders.spec.ts`, desktop+mobile): 156 passed + 2 skipped = 158/158 reconciled.
- **Mistake caught mid-session, worth remembering**: first e2e attempt ran `npx playwright test` directly (bare, no env loading) and got 56 failures, all `DATABASE_URL not found` — looked like a real regression but was just skipping `dotenv -e .env.test -e .env.local`. CLAUDE.md already says "use the `:test` env variants, never the bare scripts" for exactly this reason. Rerunning via `npm run test:e2e --` fixed it.
- Pushed (`11d254c`, SHA backfill `67ee9d7`).
- **UX-04 through UX-10 are the same shape**: design-only items, "Design review sign-off; no automated acceptance" gate, one-line backlog descriptions with no spec for the actual visual/copy choices. UX-03's propose-then-approve step (AskUserQuestion with a preview, before writing code) worked well — repeat it for each of these rather than guessing and building straight from the one-liner. Next in backlog order: UX-04 (dashboard "needs action today" row + progress bar).

## Carried forward, unchanged:

- **OPS-01 still open, deliberately skipped** — go-live readiness list (no live Stripe key, $0 deposit on imported leases, no portal invite for imported tenants, simulated e-sign, daily-cron message delay). Revisit only when going live is actually planned.
- **Shane: subscribe the test webhook endpoint to `charge.dispute.closed`.** Endpoint `we_1U47bfJ7dm36XvZPk4ekxGak` still lists `charge.dispute.created`. Swap it in the Stripe dashboard (Developers → Webhooks), or MONEY-04 never receives its event. Target set in `docs/DEPLOYMENT.md`.
- **Local `rental_test` has leftover data**: up to 4 unit tests fail on `main` too (`comms.test.ts` inbound routing ×2, `pre-move-out-scheduling-job.test.ts` ×2), while CI is green.
- **Production needs migrating**: `20260929120000` (LEGAL-02) and `20260929180000` (LEGAL-03) both pending, via the `docs/DEPLOYMENT.md` recipe. Per-push deploys are off (`bf30ca7`), so a deploy is manual too. UX-03 has no migration.
- **Roll the Stripe TEST secret key**: a masking regex printed it into the 2026-09-28 session transcript. Test mode only, not sent anywhere.
- **Not done, needs Shane:** rotate the demo password (`demo-rental-2026`, tracked in `seed-demo-access.mts` and D-257) — repo is PUBLIC so it's exposed regardless of code fixes. Consider making the repo private too.
- Cost review baseline recorded verbally (2026-09-26) but **not yet written into `07-decisions.md`**: Neon `rentalbusiness` 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel rental-business build CPU $6.76 effective / $1.41 billed for 09-01..09-26. Worth a small follow-up commit.
- Legal review and R-228 still need a person (unchanged).

## Prior: A11Y-01 through A11Y-11 all done (see `06-backlog.md` and `PROGRESS.md` for each). 7-agent review sweep scoped 2026-09-27/28 into 37 backlog rows (`90956f0`, `2c30266`). Also done: SEC-17, MONEY-01/02/03/04/06/07/08/09/10, SEC-18, SEC-19, SEC-20, LEGAL-01/02/03/04/05, UX-01, UX-02.
