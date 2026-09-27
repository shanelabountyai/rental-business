# Next session

## 7-agent review sweep is done and scoped (2026-09-27, `90956f0`). SEC-17 (demo-gate bypass) is fixed (`0200b54`, D-267). 20 new backlog rows added, money first: MONEY-01..06, SEC-17(done)..20, LEGAL-01..05, A11Y-01..03, UX-01..02, OPS-01. See `docs/prds/06-backlog.md` → "Review findings — 7-agent read-only sweep".

- **Next item: MONEY-01** (portal payments double-charge — no `recordAcrossInvoices` call, HIGH, dollars at risk). Model: **Opus** — money/webhook correctness.
- Only the top-ranked findings from the design-UX (10 found) and accessibility (11 found) agent reports were turned into rows (UX-01/02, A11Y-01..03). The fuller lists are in this conversation's transcript only, not yet in the repo — re-run those two agents if the rest are wanted later.
- SEC-17 fix pushed as `0200b54`; **not yet reconfirmed against production** post-deploy (`curl -H 'Purpose: prefetch' https://rent.labintelligence.co/login` should now 401).
- **Not done, needs Shane:** rotate the demo password (`demo-rental-2026`, tracked in `seed-demo-access.mts` and D-257) — repo is PUBLIC so it's exposed regardless of code fixes. Consider making the repo private too.
- Cost review baseline recorded verbally (2026-09-26) but **not yet written into `07-decisions.md`**: Neon `rentalbusiness` 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel rental-business build CPU $6.76 effective / $1.41 billed for 09-01..09-26. Worth a small follow-up commit.
- Legal review and R-228 still need a person (unchanged).

## Prior: R-253..R-257 done (`681fbb4`, CI green). Backlog had no open rows before this sweep.
