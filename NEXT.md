# Next session

## Done 2026-10-01: MONEY-09(b) (`2b65b9b`, `023bbde`). Refuse a portal prepayment at payment start.

- Shane decided (clickable question): prepayments are not allowed. `validatePaymentAmount` (`packages/core/payments/collection.ts`) gained a `more_than_invoiced` refusal, mirroring the staff-counter path's existing `offlinePaymentDecision` check — same class of gap, already solved once there. `startPayment` (`apps/web/lib/payments/actions.ts`) now fetches `getOpenInvoices` alongside its other recomputed facts and feeds the sum in as `openInvoiceCents`; optional on `PayableFacts` so `queries.ts`'s display-only call is untouched. D-283 records the decision.
- Gate: lint/typecheck clean. `npm test -- packages/core/payments/payments.test.ts apps/web/lib/payments/payments.test.ts apps/web/lib/billing/billing.test.ts` 129/129, verified the new check actually catches the regression (reverted, confirmed red, restored). No schema change, `db:ci` not needed.
- **Full local `npm test` was heavily flaky this session** (20-30 failed files across two consecutive runs, different counts each time) — traced to this machine's memory pressure (`kern.memorystatus_level` 35%, near the 30% swapcheck warning threshold) with a sibling project's dev server (`onsitestaffing`, :4600) resident at the same time. Confirmed NOT a regression: failures spanned unrelated modules (auth, comms, maintenance, tasks, tax), `comms.test.ts`'s 2 failures matched the pre-existing known-flaky entry below, and this item's own touched files passed clean in isolation. **If you're seeing a wall of unrelated timeouts next session, check for a sibling project's dev server before assuming a code regression** — `ps aux | grep "next dev"`.
- Pushed (`023bbde`); CI run `36880077289` was in progress when this session ended — check `gh run list --limit 3` first next session if no result landed before it cleared.

## Done 2026-09-30: MONEY-06 (`7181a97`, `db2c688`). Deterministic late-fee payer selection.

- `lib/ledger/late-fees.ts`: added `orderBy: { createdAt: 'asc' }` to both `leasePayers` queries (dated-charge pass and unlinked-rent pass), matching the primary-payer convention `billing/recurring.ts` and `billing/rubs.ts` already use. Without it, a two-payer voucher-style lease (D-13) could bill either active payer's Stripe customer nondeterministically.
- New regression test in `late-fees.test.ts`: creates a lease with two active payers seeded out of creation order, spies on `getBillingProvider().addInvoiceItem`, asserts the earlier-created payer is billed. Verified it actually catches the regression — reverted the `orderBy` locally and confirmed the test fails (wrong customer billed) before restoring the fix.
- Gate: lint/typecheck clean, `npm test apps/web/lib/ledger/late-fees.test.ts` 15/15. No schema change, `db:ci` not needed.
- **CI note:** its own CI run (`36731048340`) never finished — `ci.yml` has `cancel-in-progress: true` per branch, and the two MONEY-09(a) pushes below cancelled it. The MONEY-09(a) SHA-record push's run (`36732844569`) covers HEAD, which includes MONEY-06's changes too, so a green result there validates both. Being watched via `gh run watch` at the end of this session — **check `gh run list --limit 3` first next session if no result landed before it cleared.**

## Done 2026-09-30: MONEY-09(a) (`1007584`, `659544e`). Portal push shortfall surfaced on the drift panel.

- `lib/billing/webhook.ts`: `applySettledPortalPayment` now reads `applyPortalPayment`'s return value, not just its exceptions. `pushSplits` can fall short WITHOUT throwing (stops at the first refused split, returns what landed) — the old catch-only version missed exactly that case, and its own `ponytail:` comment ("logged only... the drift to count on /money if this ever fires") was never actually wired up. Any shortfall now writes a `ledger.drift_detected` audit row — the SAME action `recentDrift()` already reads for `/money`'s reconciliation drift panel, so no new query or UI was needed, just a new `kind: 'portal_push_shortfall'` item on the existing feed.
- New regression test in `billing.test.ts` (`a portal payment reaches the invoice (MONEY-01)` describe block): two open invoices, principal split across both, `recordOutOfBandPayment` spied so the first push lands and the second throws. Asserts the drift row exists with the right payment/kind/shortfall. Verified it actually catches the regression — reverted the `webhook.ts` change alone, confirmed the test fails (`expected null not to be null`, no drift row written), restored the fix.
- Gate: lint/typecheck clean, `npm test apps/web/lib/billing/billing.test.ts` 43/43. No schema change, `db:ci` not needed. Pushed; CI result pending — see the MONEY-06 note above, same run covers both.

## Next item: lower-severity backlog

MONEY-09(a) and (b) are both done. Remaining from the review sweep: SEC-19, SEC-20, UX-01..10, OPS-01. MONEY-05 (TX grace-day count) remains a legal-review item.

## Carried forward, unchanged:

- **Shane: subscribe the test webhook endpoint to `charge.dispute.closed`.** Endpoint `we_1U47bfJ7dm36XvZPk4ekxGak` still lists `charge.dispute.created`. Swap it in the Stripe dashboard (Developers → Webhooks), or MONEY-04 never receives its event. Target set in `docs/DEPLOYMENT.md`.
- **Local `rental_test` has leftover data**: up to 4 unit tests fail on `main` too (`comms.test.ts` inbound routing ×2, `pre-move-out-scheduling-job.test.ts` ×2), while CI is green.
- **Production needs migrating**: `20260929120000` (LEGAL-02) and `20260929180000` (LEGAL-03) both pending, via the `docs/DEPLOYMENT.md` recipe. Per-push deploys are off (`bf30ca7`), so a deploy is manual too. A11Y-01/02/03 and MONEY-06 have no migrations.
- **Roll the Stripe TEST secret key**: a masking regex printed it into the 2026-09-28 session transcript. Test mode only, not sent anywhere.
- **Not done, needs Shane:** rotate the demo password (`demo-rental-2026`, tracked in `seed-demo-access.mts` and D-257) — repo is PUBLIC so it's exposed regardless of code fixes. Consider making the repo private too.
- Cost review baseline recorded verbally (2026-09-26) but **not yet written into `07-decisions.md`**: Neon `rentalbusiness` 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel rental-business build CPU $6.76 effective / $1.41 billed for 09-01..09-26. Worth a small follow-up commit.
- Legal review and R-228 still need a person (unchanged).

## Prior: 7-agent review sweep scoped 2026-09-27/28 into 37 backlog rows (`90956f0`, `2c30266`). Done since: SEC-17, MONEY-01/02/03/04/06/07/08/10, SEC-18, LEGAL-01/02/03/04/05, A11Y-01, A11Y-02, A11Y-03. See `docs/prds/06-backlog.md` → "Review findings — 7-agent read-only sweep".
