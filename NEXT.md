# Next session

## Done 2026-09-30: MONEY-06 (`7181a97`, `db2c688`). Deterministic late-fee payer selection.

- `lib/ledger/late-fees.ts`: added `orderBy: { createdAt: 'asc' }` to both `leasePayers` queries (dated-charge pass and unlinked-rent pass), matching the primary-payer convention `billing/recurring.ts` and `billing/rubs.ts` already use. Without it, a two-payer voucher-style lease (D-13) could bill either active payer's Stripe customer nondeterministically.
- New regression test in `late-fees.test.ts`: creates a lease with two active payers seeded out of creation order, spies on `getBillingProvider().addInvoiceItem`, asserts the earlier-created payer is billed. Verified it actually catches the regression — reverted the `orderBy` locally and confirmed the test fails (wrong customer billed) before restoring the fix.
- Gate: lint/typecheck clean, `npm test apps/web/lib/ledger/late-fees.test.ts` 15/15. No schema change, `db:ci` not needed. Pushed; not yet checked against `gh run list` this session — **do that first next session**.

## Next item: MONEY-09 (LOW)

MONEY-01's two known follow-on gaps (both already marked `ponytail:` in code):
(a) A failed push to Stripe after a portal payment settles is only logged — the invoice stays open, so a retry double-charges. Fix: surface settled portal payments whose splits fall short of their principal on `/money`'s drift panel.
(b) A portal payment larger than open invoices (a prepayment) is a ledger credit Stripe can't see, so next month's invoice collects in full. Needs an owner decision first: are prepayments allowed at all? If yes, carry as a Stripe customer-balance credit.

(b) is a product decision, not a pure code item — flag it for Shane before implementing. (a) is code-closable alone (drift-panel query + display, same shape as MONEY-06). Model: Sonnet plausible for (a) alone (read-only reporting, no money written); if scope grows to touch (b)'s Stripe credit logic, recommend Opus at that point — re-ask per the model-per-item rule rather than deciding now.

Still open lower-severity after that: SEC-19, SEC-20, UX-01..10, OPS-01.

## Carried forward, unchanged:

- **Shane: subscribe the test webhook endpoint to `charge.dispute.closed`.** Endpoint `we_1U47bfJ7dm36XvZPk4ekxGak` still lists `charge.dispute.created`. Swap it in the Stripe dashboard (Developers → Webhooks), or MONEY-04 never receives its event. Target set in `docs/DEPLOYMENT.md`.
- **Local `rental_test` has leftover data**: up to 4 unit tests fail on `main` too (`comms.test.ts` inbound routing ×2, `pre-move-out-scheduling-job.test.ts` ×2), while CI is green.
- **Production needs migrating**: `20260929120000` (LEGAL-02) and `20260929180000` (LEGAL-03) both pending, via the `docs/DEPLOYMENT.md` recipe. Per-push deploys are off (`bf30ca7`), so a deploy is manual too. A11Y-01/02/03 and MONEY-06 have no migrations.
- **Roll the Stripe TEST secret key**: a masking regex printed it into the 2026-09-28 session transcript. Test mode only, not sent anywhere.
- **Not done, needs Shane:** rotate the demo password (`demo-rental-2026`, tracked in `seed-demo-access.mts` and D-257) — repo is PUBLIC so it's exposed regardless of code fixes. Consider making the repo private too.
- Cost review baseline recorded verbally (2026-09-26) but **not yet written into `07-decisions.md`**: Neon `rentalbusiness` 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel rental-business build CPU $6.76 effective / $1.41 billed for 09-01..09-26. Worth a small follow-up commit.
- Legal review and R-228 still need a person (unchanged).

## Prior: 7-agent review sweep scoped 2026-09-27/28 into 37 backlog rows (`90956f0`, `2c30266`). Done since: SEC-17, MONEY-01/02/03/04/06/07/08/10, SEC-18, LEGAL-01/02/03/04/05, A11Y-01, A11Y-02, A11Y-03. See `docs/prds/06-backlog.md` → "Review findings — 7-agent read-only sweep".
