# Next session

## Done 2026-10-01: UX-02 (`13a5a24`). Unify primary-button colour, remove ~34 hand-copied class strings.

- The backlog finding undersold it: `bg-foreground` (`PRIMARY_BUTTON_CLASSES`, ~9 callers) and hand-copied `bg-primary` (~34 callers across admin/portal/vendor/auth) both styled the same semantic "primary action" button, two different colours depending which file wrote it — not a deliberate split as `ui-classes.ts`'s own comment implied (checked: `PRIMARY_BUTTON_CLASSES` is used on form-submit buttons too, not just non-form CTAs, so the comment's claimed distinction didn't hold). **Asked Shane which colour wins** (clickable question — a real visual-design call across most of the app) — he picked `bg-primary`.
- `PRIMARY_BUTTON_CLASSES` recoloured (kept its baked-in admin size, unchanged). New `SUBMIT_BUTTON_CLASSES` in `apps/web/components/ui-classes.ts` carries appearance only (colour, focus ring incl. `ring-offset-2`, rounding, weight) — **no baked-in size**, since the 34 inline copies genuinely disagreed on size by context (compact admin CTAs vs bigger portal/auth touch targets) and unifying size wasn't part of what Shane approved. Every call site now composes `${SUBMIT_BUTTON_CLASSES} <its own size/layout classes>`.
- **Real bug found mid-item:** 6 `reports/*` pages were silently missing `focus-visible:ring-offset-2` (WCAG 2.4.7, the exact defect this file exists to prevent) — fixed for all 6 by construction, since `SUBMIT_BUTTON_CLASSES` always includes it.
- Gate: lint/typecheck/build clean. No unit test asserts on these class strings; verified via `npm run build` (catches Server/Client boundary breaks a className edit could cause) + booted `next start` and curled `/login` to confirm the composed class string renders correctly, not `undefined`. No schema change.
- Pushed (`13a5a24`). Next: UX-03..10 / OPS-01 / A11Y-04..11 (see `06-backlog.md`) — none have a stated order after UX-02, pick top of remaining list.

## Done 2026-10-01: UX-01 (`ea36958`). Sticky anchor bar + pinned header for /leases/[id].

- Sticky header (back link, title, balance, status) + five-link native `<nav>` anchor bar (Money/People/Compliance/Access/Lifecycle), reordered the page's ~30 panels into those five contiguous groups while preserving every documented pairwise ordering comment (R-084, R-175/Chase-between, R-143, R-086, R-094b — grepped for "above/below/before/after" to find all of them).
- Scoped out `<details>` collapsing (backlog's secondary suggestion) — 31 e2e spec files interact with these panels, and closing any by default would need all of them updated to open it first first, for a LOW/no-automated-acceptance polish item. Noted as a natural fold-in for UX-09 (mobile accordion) if wanted later, not done here.
- **Two real bugs found and fixed mid-item, both silent to lint/typecheck/build:** (1) naive anchor ids (`id="lifecycle"` etc.) collided with `lifecycle-panel.tsx`'s own pre-existing `id="lifecycle"`, corrupting its accessible name via `getElementById`'s first-match resolution — caught by a `getByLabel` strict-mode failure in `leases.spec.ts`, fixed by namespacing to `section-*`. (2) even after that, wrapping each group in a `<section aria-labelledby>` created a second ARIA landmark named "Lifecycle" colliding with `LifecyclePanel`'s own region — axe's `landmark-unique` rule caught it across multiple spec files' accessibility checks; fixed by making the group wrappers plain `<div>`s (not landmarks).
- Gate: lint/typecheck/build clean. No unit test covers this file (pure layout) — verified instead against the real e2e suite: **154/154 on desktop-chrome AND 154/154 on mobile-chrome**, across all 31 spec files that navigate to `/leases/[id]` (reconciled against `npx playwright test --list`). No schema change.
- Pushed (`ea36958`). Acceptance is "design review sign-off, no automated test" — a human visual pass is still outstanding; the e2e/axe green is the closest substitute so far.
- Next: UX-02 (first in remaining backlog order), or pick from UX-03..10 / OPS-01 / A11Y-04..11 (see `06-backlog.md`).

## Done 2026-10-01: SEC-20 (`ed35c1b`). filename* encoding for CJK/emoji document names.

- `documentResponse` (`apps/web/lib/documents/serve.ts`) threw inside `new Response` for any filename with a character above U+00FF (Node's header values are Latin-1) — confirmed the raw throw with a standalone repro before touching the fix. `safeFileName` now strips to printable ASCII for the legacy `filename=` fallback; new `encodedFileNameStar` RFC-5987-encodes the real name into `filename*=UTF-8''…`, which every browser prefers.
- Gate: lint/typecheck clean, `npm test -- apps/web/lib/documents/serve.test.ts` 16/16 (2 existing exact-string assertions updated, 1 new CJK+emoji regression test). No schema change.
- Pushed (`ed35c1b`). Next in backlog order: UX-01 (sticky anchor bar + collapse `/leases/[id]`'s ~30 panels — design-review acceptance, no automated gate). Lower down: UX-02..10, OPS-01, A11Y-04..11.

## Done 2026-10-01: SEC-19 (`4bc0d36`). Placeholder the Neon dev-branch hostname in a test fixture.

- `packages/db/prisma/demo-database-guard.test.ts`'s `NEON` fixture carried the real Neon dev-branch hostname in a public repo; swapped for a made-up host in the same shape. The guard only pattern-matches `localhost`/`rental_demo`, so this doesn't change what the test exercises. Scoped to the file the finding named — `docs/DEPLOYMENT.md` still documents the real hostname deliberately as an ops reference; that's the separate "repo is PUBLIC" exposure already carried below, not touched here.
- Gate: lint/typecheck clean, `npm test -- packages/db/prisma/demo-database-guard.test.ts` 10/10. No schema change.
- Pushed (`4bc0d36`). Next: SEC-20 (CJK/emoji filename 500s `lib/documents/serve.ts`).

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

MONEY-09(a)/(b) and SEC-19 are done. Remaining from the review sweep: SEC-20, UX-01..10, OPS-01. MONEY-05 (TX grace-day count) remains a legal-review item.

## Carried forward, unchanged:

- **Shane: subscribe the test webhook endpoint to `charge.dispute.closed`.** Endpoint `we_1U47bfJ7dm36XvZPk4ekxGak` still lists `charge.dispute.created`. Swap it in the Stripe dashboard (Developers → Webhooks), or MONEY-04 never receives its event. Target set in `docs/DEPLOYMENT.md`.
- **Local `rental_test` has leftover data**: up to 4 unit tests fail on `main` too (`comms.test.ts` inbound routing ×2, `pre-move-out-scheduling-job.test.ts` ×2), while CI is green.
- **Production needs migrating**: `20260929120000` (LEGAL-02) and `20260929180000` (LEGAL-03) both pending, via the `docs/DEPLOYMENT.md` recipe. Per-push deploys are off (`bf30ca7`), so a deploy is manual too. A11Y-01/02/03 and MONEY-06 have no migrations.
- **Roll the Stripe TEST secret key**: a masking regex printed it into the 2026-09-28 session transcript. Test mode only, not sent anywhere.
- **Not done, needs Shane:** rotate the demo password (`demo-rental-2026`, tracked in `seed-demo-access.mts` and D-257) — repo is PUBLIC so it's exposed regardless of code fixes. Consider making the repo private too.
- Cost review baseline recorded verbally (2026-09-26) but **not yet written into `07-decisions.md`**: Neon `rentalbusiness` 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel rental-business build CPU $6.76 effective / $1.41 billed for 09-01..09-26. Worth a small follow-up commit.
- Legal review and R-228 still need a person (unchanged).

## Prior: 7-agent review sweep scoped 2026-09-27/28 into 37 backlog rows (`90956f0`, `2c30266`). Done since: SEC-17, MONEY-01/02/03/04/06/07/08/10, SEC-18, LEGAL-01/02/03/04/05, A11Y-01, A11Y-02, A11Y-03. See `docs/prds/06-backlog.md` → "Review findings — 7-agent read-only sweep".
