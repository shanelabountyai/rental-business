# Next session

## Done 2026-09-29: A11Y-03 (`25d5686`, `d765de3`). Form value echo on server refusal.

- `sign-form.tsx`, `prescreen-form.tsx`, `applicant-form.tsx` now use `useFormVersion` + echoed `state.values` (`bid-form.tsx`'s own pattern). `FormAlerts` moved outside each keyed `<form>` per `useFormVersion`'s own warning (a `key` remounts everything inside it — the first draft put it inside all three, which would have silently undone R-101's live-region fix).
- Added `required` to sign-form's agree checkbox and prescreen's `priorEvictions` radio group. Extracted prescreen's radio+conditional-detail block into its own `PriorEvictionsFieldset` component so its local toggle state remounts (and re-seeds from the echo) along with the keyed form around it.
- `applicant-form.tsx` already had `required`/`defaultValue` on nearly every field, tied to the page's static `values` prop — the real bug was no `revalidatePath` on the refusal path plus no `key`, so a refused (but DB-persisted) submit reset the DOM to stale mounted props. Fixed by preferring `state.values` over `values`.
- Two new e2e regression tests, since adding `required` closed off most refusal paths through the browser: `prospects.spec.ts` "a refused pre-screening answer hands back what the visitor typed" (yes-with-no-detail) and `applications.spec.ts` "a refused applicant form hands back what was typed" (`isAdult()`). `sign-form.tsx` has no such path left — both fields are now browser-required — so it's covered only by the existing esign/party-change/payment-plan specs proving no regression.
- Gate: lint/typecheck clean, `db:ci` clean (no schema change). `npm test` hit the known sibling-sweep pattern first (`storage business` vitest running concurrently, 33 failures all timeouts in unrelated files); retried the 5 affected files alone once that sweep finished — 35/35 passed. e2e on both `desktop-chrome` and `mobile-chrome`: the 5 specs touching these 3 forms (20/20 each) plus the 2 new regression tests and their surrounding specs (16/16 each) — all reconciled against `--list`.
- Pushed. **Check `gh run list --limit 3` before starting the next item** to confirm CI landed green.

## Next item: MONEY-05 (LOW) — not code-closable alone

TX seed `graceDays: 1` may start the late fee a day early against Tex. Prop. Code §92.019(a)(3)'s "two full days" — this is a legal-review question, not a bug to fix in code. Folds into `docs/LEGAL-REVIEW-CHECKLIST.md`; skip it for an autonomous session unless counsel input has landed.

**Actual next code item: MONEY-06 (LOW).** Late-fee payer selection (`lib/ledger/late-fees.ts`) uses `leasePayers: { where: { active: true }, take: 1 }` with no `orderBy` in both loops — on a two-payer voucher-style lease (D-13) the fee can land on the wrong payer's Stripe customer. Fix: deterministic `orderBy` (primary payer first) or require exactly one active payer for now. Acceptance: a two-payer lease always invoices the same, correct payer for its late fee. Model: Sonnet is plausible (single-file, narrow fix) but this touches money/Stripe routing — recommend at session start, lean Opus given CLAUDE.md's "Opus stays for money" rule.

Still open lower-severity from the review sweep: MONEY-09, SEC-19/20, UX-01..10, OPS-01.

## Carried forward, unchanged:

- **Shane: subscribe the test webhook endpoint to `charge.dispute.closed`.** Endpoint `we_1U47bfJ7dm36XvZPk4ekxGak` still lists `charge.dispute.created`. Swap it in the Stripe dashboard (Developers → Webhooks), or MONEY-04 never receives its event. Target set in `docs/DEPLOYMENT.md`.
- **Local `rental_test` has leftover data**: up to 4 unit tests fail on `main` too (`comms.test.ts` inbound routing ×2, `pre-move-out-scheduling-job.test.ts` ×2), while CI is green.
- **Production needs migrating**: `20260929120000` (LEGAL-02) and `20260929180000` (LEGAL-03) both pending, via the `docs/DEPLOYMENT.md` recipe. Per-push deploys are off (`bf30ca7`), so a deploy is manual too. A11Y-01/02/03 have no migrations.
- **Roll the Stripe TEST secret key**: a masking regex printed it into the 2026-09-28 session transcript. Test mode only, not sent anywhere.
- **Not done, needs Shane:** rotate the demo password (`demo-rental-2026`, tracked in `seed-demo-access.mts` and D-257) — repo is PUBLIC so it's exposed regardless of code fixes. Consider making the repo private too.
- Cost review baseline recorded verbally (2026-09-26) but **not yet written into `07-decisions.md`**: Neon `rentalbusiness` 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel rental-business build CPU $6.76 effective / $1.41 billed for 09-01..09-26. Worth a small follow-up commit.
- Legal review and R-228 still need a person (unchanged).

## Prior: 7-agent review sweep scoped 2026-09-27/28 into 37 backlog rows (`90956f0`, `2c30266`). Done since: SEC-17, MONEY-01/02/03/04/07/08/10, SEC-18, LEGAL-01/02/03/04/05, A11Y-01, A11Y-02, A11Y-03. See `docs/prds/06-backlog.md` → "Review findings — 7-agent read-only sweep".
