# Next session

## Done 2026-10-01: A11Y-08 (`ee21071`). Duplicate ids on mortgage statement forms.

- `MortgageStatementForm` (`mortgage-statement-form.tsx`) now takes a required `mortgageId` prop and derives `idPrefix` as `` `statement-${mortgageId}` `` instead of the fixed `idPrefix="statement"` that collided across every mortgage statement form on a property with 2+ mortgages. Call site in `filing-cabinet-section.tsx` passes `mortgageId={mortgage.id}`.
- Gate: lint/typecheck/build clean. No unit/e2e coverage — no existing axe assertion exercises the filing-cabinet section with two mortgages on one property.
- Pushed (`ee21071`, SHA backfill `d361d10`).
- Next in backlog order: A11Y-09 (delete button labels/target size/result region), then A11Y-10, A11Y-11, then UX-03..10.

## Prior 2026-10-01: A11Y-07 (`e85fe17`). Rent amount field contrast + unlinked error.

- Swapped the hand-rolled `className` on both amount inputs (`pay-form.tsx:73`, `offline-payment-form.tsx:100`) for `INPUT_CLASSES` (`components/ui-classes.ts`) — the plain `border` utility they used was ~1.26:1 contrast, under WCAG 1.4.11's 3:1. `pay-form.tsx` appends its deliberate `w-40 text-lg` after `INPUT_CLASSES` (D-10's large-text requirement for a phone rent-pay screen); `offline-payment-form.tsx` keeps `w-32`. Added `aria-invalid={Boolean(fieldErrors?.amountDollars) || undefined}` to both.
- `offline-payment-form.tsx` already had `FieldError`/`aria-describedby` wired for this field (R-099) — only the class and `aria-invalid` were missing. `pay-form.tsx` had neither: added a `FieldError` region under the existing `amount-hint` paragraph; `aria-describedby` now lists both ids when an error is present.
- Gate: lint/typecheck/build clean. No unit/e2e coverage — contrast ratio and `aria-invalid` have no DOM-structure or accessible-name signal for axe/Playwright to regress-check; not yet confirmed by a person with a contrast checker.
- Pushed (`e85fe17`, SHA backfill `49474ee`).
- Next in backlog order: A11Y-08 (duplicate ids on mortgage statement forms), then A11Y-09..11, then UX-03..10.

## Prior 2026-10-01: A11Y-06 (`a2a97a5`). `autoComplete` on name/email/phone/address fields.

- Added `autoComplete?: string` to `TextField` (`apps/web/components/form/field.tsx`), no default — a wrong guessed token is worse than none. Wired it at the three call sites the finding named: `applicant-form.tsx` (`given-name`/`family-name`/`email`/`tel`/`bday`, plus `street-address`/`address-level2`/`address-level1`/`postal-code` on the current-address fieldset), `listing-inquiry-form.tsx` (`given-name`/`family-name`/`email`/`tel`), and `self-showing-form.tsx`'s photo-ID name field (`name`). Left `employerName`/`monthlyIncome` alone — no standard autocomplete token fits either.
- Gate: lint/typecheck/build clean. No unit/e2e coverage — `autoComplete` has no accessible-name or DOM-structure effect for Playwright/axe to catch a regression in; actual autofill behavior is a manual browser check, not yet performed by a person.
- Pushed (`a2a97a5`, SHA backfill `b24635e`).
- Next in backlog order: A11Y-07 (rent amount field contrast + unlinked error), then A11Y-08..11, then UX-03..10.

## Prior 2026-10-01: A11Y-05 (`a09d84f`). Focus post-redirect notices instead of mounting them silent.

- Added `FocusedStatus` to `apps/web/components/auth-form.tsx` — a `role="status"` paragraph wired to the existing `useFocusWhen<HTMLParagraphElement>(true)` hook, focusing itself on mount. Both sites in the finding were async Server Components rendering a bare `<p role="status">` already populated on first paint (search-param-driven, one render only): the emergency "We have paged someone now" banner (`app/portal/(signed-in)/maintenance/[id]/page.tsx`) and the login "Your password was changed" notice (`app/login/page.tsx`). Replaced both with `<FocusedStatus className="...">`.
- On `/login`, `FocusedStatus`'s post-hydration focus correctly wins over the Email field's native `autoFocus` (which fires earlier, during initial parse) — no explicit ordering logic needed, just a side effect of effects running after hydration.
- Gate: lint/typecheck/build clean. No new Server/Client boundary (`FocusedStatus` lives inside the already-`'use client'` `auth-form.tsx`). No unit/e2e coverage by design — same manual screen-reader acceptance gap as A11Y-04, not yet performed by a person.
- Pushed (`a09d84f`, SHA backfill `a62788c`).
- Next in backlog order: A11Y-06 (missing `autoComplete` on `TextField`), then A11Y-07..11, then UX-03..10.

## Prior 2026-10-01: A11Y-04 (`c0ad7e2`). Focus the autopay confirmation heading instead of an inert live region.

- `AutopayPanel` (`apps/web/components/payments/autopay-panel.tsx`) swaps its whole "off" branch for its "on" branch in one render pass on save success — the same whole-section-replacement shape `useFocusWhen` was already written for (MFA enrolment, vendor bid/job panels, portal verify-link). The `role="status"` confirmation mounted already populated (announces nothing) and the Save button that had focus unmounted with it. Added `useFocusWhen<HTMLHeadingElement>(saved)` on the panel's `h2` — `ref`+`tabIndex={-1}`, matching `bid-form.tsx`/`verify-panel.tsx`'s exact pattern. Driven by `saved` (client action state), never `alreadyOn` (a server prop also true on an ordinary page load).
- Gate: lint/typecheck/build clean. Caught one real mistake mid-edit: the hook was first placed after the panel's `if (!publishableKey) return null`, which trips `react-hooks/rules-of-hooks` — fixed by moving it above the early return. No unit/e2e coverage possible by design (D-15: Stripe Elements is a cross-origin iframe); acceptance is a manual screen-reader check, not yet performed by a person. No schema change.
- Pushed (`c0ad7e2`). Shane chose (clickable question) to skip OPS-01 (go-live readiness review, not a single code fix — no go-live currently planned) and go straight to A11Y-04. OPS-01 is still open at its place in `06-backlog.md`; revisit when going live is actually being planned.
- Next in backlog order: A11Y-05 (silent post-redirect messages — emergency maintenance page, login notice). Then A11Y-06..11, then UX-03..10.

## Carried forward, unchanged:

- **OPS-01 still open, deliberately skipped this session** — go-live readiness list (no live Stripe key, $0 deposit on imported leases, no portal invite for imported tenants, simulated e-sign, daily-cron message delay). Its own "Fix" column says scope each gap into its own item only when going live is actually planned. Revisit then, not before.
- **Shane: subscribe the test webhook endpoint to `charge.dispute.closed`.** Endpoint `we_1U47bfJ7dm36XvZPk4ekxGak` still lists `charge.dispute.created`. Swap it in the Stripe dashboard (Developers → Webhooks), or MONEY-04 never receives its event. Target set in `docs/DEPLOYMENT.md`.
- **Local `rental_test` has leftover data**: up to 4 unit tests fail on `main` too (`comms.test.ts` inbound routing ×2, `pre-move-out-scheduling-job.test.ts` ×2), while CI is green.
- **Production needs migrating**: `20260929120000` (LEGAL-02) and `20260929180000` (LEGAL-03) both pending, via the `docs/DEPLOYMENT.md` recipe. Per-push deploys are off (`bf30ca7`), so a deploy is manual too. A11Y-01/02/03/04 and MONEY-06 have no migrations.
- **Roll the Stripe TEST secret key**: a masking regex printed it into the 2026-09-28 session transcript. Test mode only, not sent anywhere.
- **Not done, needs Shane:** rotate the demo password (`demo-rental-2026`, tracked in `seed-demo-access.mts` and D-257) — repo is PUBLIC so it's exposed regardless of code fixes. Consider making the repo private too.
- Cost review baseline recorded verbally (2026-09-26) but **not yet written into `07-decisions.md`**: Neon `rentalbusiness` 41.6 CU-h / 161.2 active-h since 2026-09-17; Vercel rental-business build CPU $6.76 effective / $1.41 billed for 09-01..09-26. Worth a small follow-up commit.
- Legal review and R-228 still need a person (unchanged).

## Prior: 7-agent review sweep scoped 2026-09-27/28 into 37 backlog rows (`90956f0`, `2c30266`). Done since: SEC-17, MONEY-01/02/03/04/06/07/08/09/10, SEC-18, SEC-19, SEC-20, LEGAL-01/02/03/04/05, A11Y-01/02/03/04, UX-01, UX-02. See `docs/prds/06-backlog.md` → "Review findings — 7-agent read-only sweep".
