# Next session

## 7-agent review sweep is done and scoped (2026-09-27/28, `90956f0`, `2c30266`). SEC-17 (demo-gate bypass) is fixed (`0200b54`, D-267). All 37 findings are now backlog rows, none dropped: MONEY-01..06, SEC-17(done)..20, LEGAL-01..05, A11Y-01..11, UX-01..10, OPS-01. See `docs/prds/06-backlog.md` → "Review findings — 7-agent read-only sweep".

- **Done 2026-09-28:** MONEY-01, -02, -03, -07, -08, -10, SEC-18, and **MONEY-04** (`4c23965`, D-274: `charge.dispute.closed` with `status: lost` reverses the payment).
- **Shane: subscribe the test webhook endpoint to `charge.dispute.closed`.** Endpoint `we_1U47bfJ7dm36XvZPk4ekxGak` still lists `charge.dispute.created`. Swap it in the Stripe dashboard (Developers → Webhooks), or MONEY-04 never receives its event. The target set is in `docs/DEPLOYMENT.md`. The in-session edit was refused as a shared-resource change.
- **CI**: runs for `c437056` (MONEY-04) and `89aa89c` (SEC-18, which also covers MONEY-03/07/08) were in flight at handoff. Check with `gh run list --limit 3`.
- **Local `rental_test` has leftover data**: 4 unit tests fail on `main` too (`comms.test.ts` inbound routing ×2, `pre-move-out-scheduling-job.test.ts` ×2), while CI is green.
- **Next item: LEGAL-01 (HIGH)**, where screening lookback windows are configured but never applied. LEGAL-02 is also HIGH. The earlier "no HIGH rows open" line was wrong. Model: **Opus** (fair-housing correctness).
- SEC-17's backlog row has no ✅ although D-267 fixed it (`0200b54`). Mark it when next in the file.
- **Roll the Stripe TEST secret key**: a masking regex printed it into the 2026-09-28 session transcript. Test mode only, not sent anywhere.
- SEC-17 reconfirmed in production 2026-09-28 (prefetch → 401).
- **Not done, needs Shane:** rotate the demo password (`demo-rental-2026`, tracked in `seed-demo-access.mts` and D-257) — repo is PUBLIC so it's exposed regardless of code fixes. Consider making the repo private too.
- Cost review baseline recorded verbally (2026-09-26) but **not yet written into `07-decisions.md`**: Neon `rentalbusiness` 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel rental-business build CPU $6.76 effective / $1.41 billed for 09-01..09-26. Worth a small follow-up commit.
- Legal review and R-228 still need a person (unchanged).

## Prior: R-253..R-257 done (`681fbb4`, CI green). Backlog had no open rows before this sweep.
