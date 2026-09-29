# Next session

## 7-agent review sweep is done and scoped (2026-09-27/28, `90956f0`, `2c30266`). SEC-17 (demo-gate bypass) is fixed (`0200b54`, D-267). All 37 findings are now backlog rows, none dropped: MONEY-01..06, SEC-17(done)..20, LEGAL-01..05, A11Y-01..11, UX-01..10, OPS-01. See `docs/prds/06-backlog.md` → "Review findings — 7-agent read-only sweep".

- **Done 2026-09-28:** MONEY-01, -02, -03, -07, -08, -10, SEC-18, and **MONEY-04** (`4c23965`, D-274: `charge.dispute.closed` with `status: lost` reverses the payment).
- **Shane: subscribe the test webhook endpoint to `charge.dispute.closed`.** Endpoint `we_1U47bfJ7dm36XvZPk4ekxGak` still lists `charge.dispute.created`. Swap it in the Stripe dashboard (Developers → Webhooks), or MONEY-04 never receives its event. The target set is in `docs/DEPLOYMENT.md`. The in-session edit was refused as a shared-resource change.
- **CI green** for `c437056` (run 36470684616, both jobs), which covers MONEY-03/04/07/08/10 and SEC-18.
- **Local `rental_test` has leftover data**: up to 4 unit tests fail on `main` too (`comms.test.ts` inbound routing ×2, `pre-move-out-scheduling-job.test.ts` ×2), while CI is green.
- **Done 2026-09-28: LEGAL-01** (`911b03c`, D-275): a screening record is cited as within the lookback only when a provider-reported date puts it there.
- **Production migrated 2026-09-29** through LEGAL-01, MONEY-01's migration included. The recipe that works (Neon CLI, not `vercel env pull`) is in `docs/DEPLOYMENT.md`.
- **Done 2026-09-29: LEGAL-02** (`8963909`, D-276): the adverse-action notice discloses score, range, key factors, date and source. Wording still needs counsel. **Production needs migrating** (`20260929120000_legal02_credit_score_disclosure` pending) via the `docs/DEPLOYMENT.md` recipe.
- **Done 2026-09-29: LEGAL-03** (`8ae6056`, D-278): prospect/applicant texts need consent; inquiry form has an optional texting checkbox; co-applicant invites require an email. **Production needs migrating**: `20260929120000` (LEGAL-02) and `20260929180000` (LEGAL-03) both pending, via the `docs/DEPLOYMENT.md` recipe. Per-push deploys are now off (`bf30ca7`), so a deploy is manual too.
- **Done 2026-09-29: LEGAL-04** (`2f91930`, D-279): SMS opts out on the FCC per-se words and a closed list of revocation sentences ("please stop texting me"); a bare YES no longer resubscribes. No migration.
- **Done 2026-09-29: LEGAL-05** (`2c97b1c`, D-280): on any Vercel deployment the logging adapter logs `CHANNEL logged as log_<id>` only; a laptop still prints the body (the demo walk reads magic links from it). No migration.
- **Next item: A11Y-01 (HIGH)**: tenant bottom nav (7 items, `components/portal/portal-nav.tsx`) likely overflows 320/412px phones. Screenshot first, then wrap or move "Account" to the header; add a `shell.spec.ts`-style overflow check. Run `--project=mobile-chrome`. Model: **Sonnet** (UI layout, no money/permission logic). Still open lower-severity: MONEY-05/06/09, SEC-19/20.
- **Local unit runs time out when a sibling project's sweep overlaps** (2026-09-29: 52 timeouts with `onsitestaffing`/`tradepost` running; rerun at `--maxWorkers=2` went 422/424). Check `ps aux | grep -E "vitest|playwright"` before a full `npm test`.
- **Roll the Stripe TEST secret key**: a masking regex printed it into the 2026-09-28 session transcript. Test mode only, not sent anywhere.
- SEC-17 reconfirmed in production 2026-09-28 (prefetch → 401).
- **Not done, needs Shane:** rotate the demo password (`demo-rental-2026`, tracked in `seed-demo-access.mts` and D-257) — repo is PUBLIC so it's exposed regardless of code fixes. Consider making the repo private too.
- Cost review baseline recorded verbally (2026-09-26) but **not yet written into `07-decisions.md`**: Neon `rentalbusiness` 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel rental-business build CPU $6.76 effective / $1.41 billed for 09-01..09-26. Worth a small follow-up commit.
- Legal review and R-228 still need a person (unchanged).

## Prior: R-253..R-257 done (`681fbb4`, CI green). Backlog had no open rows before this sweep.
