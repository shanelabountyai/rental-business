# Next session

## Done 2026-09-29: A11Y-02 (`7f36bae`, `a2b21bd`, D-282). Pending/busy buttons no longer hard-`disabled`.

- Fixed all 7 sites: `autopay-panel.tsx` (2), `fee-payment.tsx` (1), `maintenance-wizard.tsx` (1), `translations-panel.tsx` (2), `rent-roll-table.tsx` (1). The 5 plain `type="submit"` form-action sites spread `pendingButtonProps(pending)`; the 2 `type="button"` `onClick`-driven sites in `autopay-panel.tsx` got manual `aria-disabled`/`aria-busy` plus an `if (busy) return` guard, because spreading `pendingButtonProps` doesn't compose with a caller's own `onClick` (JSX spread is last-key-wins — one order loses the guard, the other loses the real handler).
- Dropped the redundant `disabled:opacity-60`/`-50` classes alongside; the shared button-class constants already carry `aria-disabled:cursor-not-allowed`.
- Deliberately out of scope, left unchanged: `autopay-panel.tsx:81` and `fee-payment.tsx:68` (`disabled={busy || !stripeApi}`) — combined with a real non-pending condition, and not reachable by axe/e2e (Stripe Elements iframe). See D-282 if Stripe-elements coverage is ever added.
- **First `npm test` run showed 41 failures across 19 files** — all `afterAll` hook timeouts, traced to two sibling projects' sweeps running concurrently (`apptbasedservice` vitest, `storage business` playwright) exhausting the shared local Postgres pool. Confirmed via `ps aux` and reasoning from `~/.claude/docs/conventions.md`'s documented pattern, not a real regression (none of the failing files touch the 5 edited components). Retry: 3471 passed/4 skipped/2 failed — the known local-data `comms.test.ts` failures.
- `PORT=3100 npm run test:e2e` on the 5 affected specs (`portal`, `pay`, `rent-roll`, `applications`, `announcements`) against a production build: 93 passed/1 skipped, reconciled against `--list`'s 94.
- Pushed. `.github/workflows/ci.yml` has `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`, so the A11Y-02 push cancelled A11Y-01's still-running CI check — A11Y-02's own CI run covers both commits at the tip of `main`. **Check `gh run list --limit 3` before starting the next item** — confirm that run landed green before trusting main.

## Next item: A11Y-03 (MED)

Three tenant/applicant forms wipe typed input on server refusal (`sign-form.tsx`, `prescreen-form.tsx`, `applicant-form.tsx`) — missing `required` on key fields and no echoed values on error, unlike `bid-form.tsx`. Fix: add `required`; use `useFormVersion` + echoed values as `bid-form.tsx` does. Acceptance: a refused submission on any of the three re-renders the typed values. Model: recommend at session start — this follows an existing pattern (`bid-form.tsx`) closely but touches per-field logic in 3 files, so weigh Sonnet (spec-following an established pattern) against Opus if the echo logic turns out non-trivial per form.

Still open lower-severity from the review sweep: MONEY-05/06/09, SEC-19/20, UX-01..10, OPS-01.

## Carried forward, unchanged:

- **Shane: subscribe the test webhook endpoint to `charge.dispute.closed`.** Endpoint `we_1U47bfJ7dm36XvZPk4ekxGak` still lists `charge.dispute.created`. Swap it in the Stripe dashboard (Developers → Webhooks), or MONEY-04 never receives its event. Target set in `docs/DEPLOYMENT.md`.
- **Local `rental_test` has leftover data**: up to 4 unit tests fail on `main` too (`comms.test.ts` inbound routing ×2, `pre-move-out-scheduling-job.test.ts` ×2), while CI is green. Confirmed again this session — same 2 seen on the clean retry (comms.test.ts only; pre-move-out wasn't in this run's failure set at all).
- **Production needs migrating**: `20260929120000` (LEGAL-02) and `20260929180000` (LEGAL-03) both pending, via the `docs/DEPLOYMENT.md` recipe. Per-push deploys are off (`bf30ca7`), so a deploy is manual too. A11Y-01/A11Y-02 have no migrations.
- **Roll the Stripe TEST secret key**: a masking regex printed it into the 2026-09-28 session transcript. Test mode only, not sent anywhere.
- **Not done, needs Shane:** rotate the demo password (`demo-rental-2026`, tracked in `seed-demo-access.mts` and D-257) — repo is PUBLIC so it's exposed regardless of code fixes. Consider making the repo private too.
- Cost review baseline recorded verbally (2026-09-26) but **not yet written into `07-decisions.md`**: Neon `rentalbusiness` 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel rental-business build CPU $6.76 effective / $1.41 billed for 09-01..09-26. Worth a small follow-up commit.
- Legal review and R-228 still need a person (unchanged).

## Prior: 7-agent review sweep scoped 2026-09-27/28 into 37 backlog rows (`90956f0`, `2c30266`). Done since: SEC-17, MONEY-01/02/03/04/07/08/10, SEC-18, LEGAL-01/02/03/04/05, A11Y-01, A11Y-02. See `docs/prds/06-backlog.md` → "Review findings — 7-agent read-only sweep".
