# Next session

## 7-agent review sweep is done and scoped (2026-09-27/28, `90956f0`, `2c30266`). SEC-17 (demo-gate bypass) is fixed (`0200b54`, D-267). All 37 findings are now backlog rows, none dropped: MONEY-01..06, SEC-17(done)..20, LEGAL-01..05, A11Y-01..11, UX-01..10, OPS-01. See `docs/prds/06-backlog.md` → "Review findings — 7-agent read-only sweep".

- **MONEY-01 done** (`90c4539`, D-268). It also fixed a live autopay double-credit: under `2026-07-29.dahlia` a PaymentIntent has no `invoice` field, so events.ts's guard was dead. Filed MONEY-07 (card fee credited as rent), MONEY-08 (stuck autopay ACH `PENDING` row), MONEY-09 (MONEY-01's logged-only push failure and prepayment gaps). **Check CI went green for `b1ac000`** (`gh run list --limit 3`).
- **Next item: MONEY-02** (webhook event lost if projection throws after the claim, HIGH). Model: **Opus**. MONEY-07 and MONEY-08 are good candidates right after it: same pipeline, context still fresh in D-268.
- **Roll the Stripe TEST secret key**: a masking regex printed it into the 2026-09-28 session transcript. Test mode only, not sent anywhere.
- SEC-17 fix pushed as `0200b54`; **not yet reconfirmed against production** post-deploy (`curl -H 'Purpose: prefetch' https://rent.labintelligence.co/login` should now 401).
- **Not done, needs Shane:** rotate the demo password (`demo-rental-2026`, tracked in `seed-demo-access.mts` and D-257) — repo is PUBLIC so it's exposed regardless of code fixes. Consider making the repo private too.
- Cost review baseline recorded verbally (2026-09-26) but **not yet written into `07-decisions.md`**: Neon `rentalbusiness` 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel rental-business build CPU $6.76 effective / $1.41 billed for 09-01..09-26. Worth a small follow-up commit.
- Legal review and R-228 still need a person (unchanged).

## Prior: R-253..R-257 done (`681fbb4`, CI green). Backlog had no open rows before this sweep.
