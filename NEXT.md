# Next session

## 7-agent review sweep is done and scoped (2026-09-27/28, `90956f0`, `2c30266`). SEC-17 (demo-gate bypass) is fixed (`0200b54`, D-267). All 37 findings are now backlog rows, none dropped: MONEY-01..06, SEC-17(done)..20, LEGAL-01..05, A11Y-01..11, UX-01..10, OPS-01. See `docs/prds/06-backlog.md` → "Review findings — 7-agent read-only sweep".

- **MONEY-01 done** (`90c4539`, D-268, CI green). **MONEY-02 done** (`da1541f`, D-269): a throw after the claim marks it `failed` and the retry retakes it; stale `received` claims (>15 min) are retaken; `projected` commits in the projection tx. **Its full `npm test` did not run clean locally** (4 other projects' sweeps at once, all timeouts). CI green for `59077c4` (full unit + e2e sweep).
- **MONEY-07 done** (`10a74ee`, D-270). **MONEY-08 done** (`ab9e0ad`, D-271): an invoice event with no PaymentIntent adopts the matching PENDING autopay row (same payer + amount, last 10 days, no `payment.intent_created` audit) instead of writing a second row. **CI for `a7dc2a5` and `5cd58af` not yet checked**: run `gh run list --limit 3`.
- **Local `rental_test` has leftover data**: 4 unit tests fail on `main` too (`comms.test.ts` inbound routing ×2, `pre-move-out-scheduling-job.test.ts` ×2), while CI is green. Worth a look before trusting a local `npm test`.
- **Next item: MONEY-03 + MONEY-10 together** (refunds project Stripe's running `amount_refunded`, not the delta; and a full card refund re-opens the fee). Both live in the `charge.refunded` branch of `packages/core/billing/events.ts` and its projection. Model: **Opus**. D-268..D-271 hold the context.
- **Roll the Stripe TEST secret key**: a masking regex printed it into the 2026-09-28 session transcript. Test mode only, not sent anywhere.
- SEC-17 reconfirmed in production 2026-09-28 (prefetch → 401).
- **Not done, needs Shane:** rotate the demo password (`demo-rental-2026`, tracked in `seed-demo-access.mts` and D-257) — repo is PUBLIC so it's exposed regardless of code fixes. Consider making the repo private too.
- Cost review baseline recorded verbally (2026-09-26) but **not yet written into `07-decisions.md`**: Neon `rentalbusiness` 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel rental-business build CPU $6.76 effective / $1.41 billed for 09-01..09-26. Worth a small follow-up commit.
- Legal review and R-228 still need a person (unchanged).

## Prior: R-253..R-257 done (`681fbb4`, CI green). Backlog had no open rows before this sweep.
