# Next session

## Done 2026-09-29: A11Y-01 (`500c51a`, `9ebf254`, D-281). Tenant bottom nav no longer overflows/collides on a phone.

- Confirmed the defect by screenshot before fixing, at 320px and 412px: "Messages"/"Account" ran together with no gap at 320px, and "Account" was pushed fully off-screen and unreachable at 412px. Neither showed as `documentElement.scrollWidth` overflow, because the nav is `position: fixed` — a fixed box's own overflow doesn't widen the document, so the `shell.spec.ts`-style check the backlog row proposed would have missed both.
- Root cause was two separate `min-width: auto` floors: the `<li>` itself, and the bare `{item.label}` text becoming an *anonymous* flex item inside the `flex-col` link (an anonymous flex item can't be targeted by a class on its parent). Fix: `min-w-0` on the `<li>`, and the label wrapped in its own `<span className="w-full min-w-0 break-words">`.
- New regression test in `e2e/portal.spec.ts` ("keeps every bottom-nav item on screen and separate on a phone") asserts every link's own `getBoundingClientRect` at 320px/412px — verified it actually fails against the pre-fix component before restoring the fix.
- Gate green: lint/typecheck clean, `npm test` 3469 passed/4 skipped/4 failed (the same known local-data failures noted below, unchanged count), `e2e/portal.spec.ts` + `e2e/shell.spec.ts` against a production build on both projects: 52 passed/2 skipped.
- **CI was still in flight for `9ebf254` when this session ended** (`gh run list --limit 3` showed `in_progress` at push time). Check `gh run list --limit 3` before starting the next item — don't assume green from the local gate alone (see the CLAUDE.md warning about copying that sentence forward unchecked).

## Next item: A11Y-02 (MED)

`disabled={busy}` (the R-107a defect) is back at 7 sites (`autopay-panel.tsx`, `fee-payment.tsx`, `maintenance-wizard.tsx`, `translations-panel.tsx`, `rent-roll-table.tsx`) — drops focus to `<body>`, "Paying…"/"Sending…" unannounced, and `disabled:opacity-60` drops contrast to ~2.2:1. Fix: spread `pendingButtonProps(busy)` at all 7 sites; drop the opacity class. Acceptance: axe sweep of these 7 components has no `disabled`-on-pending violation. Model: **Sonnet** (mechanical, spec-following — apply an existing helper at named sites, no new logic).

Still open lower-severity from the review sweep: MONEY-05/06/09, SEC-19/20, A11Y-03, UX-01..10, OPS-01.

## Carried forward, unchanged:

- **Shane: subscribe the test webhook endpoint to `charge.dispute.closed`.** Endpoint `we_1U47bfJ7dm36XvZPk4ekxGak` still lists `charge.dispute.created`. Swap it in the Stripe dashboard (Developers → Webhooks), or MONEY-04 never receives its event. Target set in `docs/DEPLOYMENT.md`.
- **Local `rental_test` has leftover data**: up to 4 unit tests fail on `main` too (`comms.test.ts` inbound routing ×2, `pre-move-out-scheduling-job.test.ts` ×2), while CI is green. Confirmed again this session — same 4, unrelated to A11Y-01.
- **Production needs migrating**: `20260929120000` (LEGAL-02) and `20260929180000` (LEGAL-03) both pending, via the `docs/DEPLOYMENT.md` recipe. Per-push deploys are off (`bf30ca7`), so a deploy is manual too. A11Y-01 has no migration.
- **Roll the Stripe TEST secret key**: a masking regex printed it into the 2026-09-28 session transcript. Test mode only, not sent anywhere.
- **Not done, needs Shane:** rotate the demo password (`demo-rental-2026`, tracked in `seed-demo-access.mts` and D-257) — repo is PUBLIC so it's exposed regardless of code fixes. Consider making the repo private too.
- Cost review baseline recorded verbally (2026-09-26) but **not yet written into `07-decisions.md`**: Neon `rentalbusiness` 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel rental-business build CPU $6.76 effective / $1.41 billed for 09-01..09-26. Worth a small follow-up commit.
- Legal review and R-228 still need a person (unchanged).

## Prior: 7-agent review sweep scoped 2026-09-27/28 into 37 backlog rows (`90956f0`, `2c30266`). Done since: SEC-17, MONEY-01/02/03/04/07/08/10, SEC-18, LEGAL-01/02/03/04/05, A11Y-01. See `docs/prds/06-backlog.md` → "Review findings — 7-agent read-only sweep".
