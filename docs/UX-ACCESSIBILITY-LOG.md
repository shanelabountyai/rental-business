# UX & Accessibility review — findings, verdicts, fixes

**Reviewed:** 2026-08-11 · **Scope:** every screen in `apps/web/app` and every component in `apps/web/components`, across all three audiences (tenant portal, vendor magic-link, staff admin).

Two independent review passes were run over the whole product — one on UX against modern standards, one on accessibility beyond what the automated gate can see. This file records **every** finding, whether I could verify it, what I did about it, and — where I declined — why.

## How this is being worked

The report is split across two backlog items, because "fix the whole report"
is not a session and the tiers have genuinely different stakes:

- **R-098 — the safety tier. ✅ Landed.** The emergency maintenance flow and
  the vendor surface: the two places where a defect has a consequence outside
  the screen. Everything marked `FIXED (R-098)` below.
- **R-099 — the rest.** Focus management, the missing route boundaries, the
  inert live regions, the wizard, the timezone display sites, and the gate's
  own gap. Everything marked `R-099` below.

## How to read this

- Each finding has a **verdict**: `CONFIRMED` (I reproduced it), `PARTLY` (real but overstated), `REJECTED` (checked, not true), or `DEFERRED` (real, filed, not done here).
- Findings are the reviewers'; the verdicts and decisions are mine. Two claims were wrong and are recorded as wrong rather than quietly dropped.
- A section at the end lists what both reviews called out as **already correct and not to be touched**. That list is load-bearing: several of those choices were expensive to arrive at and are easy to "tidy up" into bugs.

---

## The two systemic findings

Everything else is downstream of these.

### S1 — There is no focus management anywhere in the product `CONFIRMED`

`grep -rn "\.focus()" apps/web/app apps/web/components` returns **zero results**.

Every place a server action succeeds or a `useState` toggle flips, the element holding focus unmounts and focus falls to `<body>`. A screen-reader or keyboard user is returned to the top of the document with nothing announced, and must re-navigate to find out what happened. This is invisible to axe by construction: axe scans a static snapshot and cannot see where focus went.

This single gap is the root of a11y findings H1, H2, H6, H7, M4, M7 and M11.

### S2 — `role="status"` is used eleven times, and mostly announces nothing `CONFIRMED`

A live region only announces *mutations*. In most uses here the region is inserted into the DOM at the same moment as its content, or is server-rendered and never mutates — so the first appearance, the one that matters, is silent. `role="alert"` is special-cased by browsers and survives this; `role="status"` does not.

The codebase already states the rule correctly in `components/auth-form.tsx:86` (alert for failure, status for confirmation). Later files copied the attribute without its precondition: **the region must already exist before the content arrives.**

---

## Accessibility — High severity

| # | Finding | Verdict | Decision |
|---|---|---|---|
| H1 | Emergency flow: safety screen never announced, focus destroyed reaching it (`emergency-flow.tsx:109-196`) | `CONFIRMED` | **FIXED (R-098).** Solved by deletion rather than by announcing: the safety screen is now its own server-rendered URL, so it is a real navigation and there is no focus to preserve or announce. |
| H2 | Maintenance wizard: same defect across seven steps, no progress indication | `CONFIRMED` | **R-099.** Same defect, no safety consequence — a tenant reporting a dripping tap is not a tenant smelling gas. |
| H3 | Wizard/emergency option selection is colour + font-weight only; no `aria-pressed` or radio semantics | `CONFIRMED` | **FIXED (R-098) in the emergency flow** — real radios, plus an explicit third "I am not sure". The wizard half is **R-099**. |
| H4 | Disabled "Next" buttons leave the tab order and give no reason | `CONFIRMED` | **FIXED (R-098) in the emergency flow**, by removing the disabling rather than explaining it — see the note below. Wizard half is **R-099**. |
| H5 | `sr-only` inputs with `focus-visible:ring` on a label that never receives focus — no visible focus indicator at all | `CONFIRMED` | **R-099.** The emergency flow's own instance is gone (its radios use `focus-within:ring` on the label, which does fire); the other two sites remain, including `offline-payment-form.tsx`, which I wrote in R-038. |
| H6 | Vendor "Show code": focus destroyed, code never announced, N identical button names | `CONFIRMED` | **FIXED (R-098).** All three: `<output>` rendered empty from first paint so the reveal is a mutation and announces, `autoFocus` on the revealed code, and a per-code accessible name. |
| H7 | Vendor accept/propose/decline triggers unmount themselves | `CONFIRMED` | **FIXED (R-098)** with `<details>`, the pattern the admin side already uses. Three forms, one action — which also fixed the U9 instance on this screen for free. |

## Accessibility — Medium severity

| # | Finding | Verdict | Decision |
|---|---|---|---|
| M1 | Card-fee disclosure: conditionally mounted region, recomputed per keystroke, not associated with the CARD radio | `CONFIRMED` | **Fixing.** PAY-01 requires the fee be disclosed *before* the choice; a screen-reader user arrowing the radio group currently hears no fee at all. |
| M2 | Tenant reply form never confirms a message was sent | `CONFIRMED` | **Fixing** — use `FormAlerts`, which already handles it. |
| M3 | Verify panel 1–5 rating built from toggle buttons; the rating is the one part that needs hydration | `CONFIRMED` | **Fixing** as radios. |
| M4 | Successful actions swap whole sections silently (three sites) | `CONFIRMED` | **Fixing** alongside S1. |
| M5 | Property switcher navigates on `change` and disables the focused control | `CONFIRMED` | **Fixing** — `aria-busy` instead of `disabled`. |
| M6 | Horizontally scrolling tables not keyboard-reachable (3 sites) | `CONFIRMED` | **Fixing** — copy the four attributes from `tasks/page.tsx`. Note axe only catches this when the table actually overflows at the test viewport, so it is **not reliably gated today**. |
| M7 | Fees panel: N identical triggers, error without `role="alert"`, focus loss | `CONFIRMED` | **R-099.** Mine, from R-041, written hours earlier. |
| M8 | Two offline-payment errors have no `id` and no `aria-describedby` | `CONFIRMED` | **Fixing** — use `TextField`, which does this correctly. Also mine, from R-038. |
| M9 | `<legend>` nested two `<div>`s deep contributes no accessible name | `CONFIRMED` | **Fixing.** Each troubleshooting step is an unnamed group with identically-named buttons. |
| M10 | Emergency reassurance banner: inert `role="status"`, sits above the `<h1>` so heading navigation skips it | `CONFIRMED` | **FIXED (R-098).** Gone with the rewrite: the reassurance is ordinary server-rendered prose under the `<h1>`, which is what it always was — a live region announcing text that never changes was the wrong tool for it. |
| M11 | Photo upload status not announced; disables the focused control | `CONFIRMED` | **Fixing.** |

## UX — High severity

| # | Finding | Verdict | Decision |
|---|---|---|---|
| U1 | No `error.tsx`, `not-found.tsx` or `loading.tsx` anywhere | `CONFIRMED` — zero files | **Fixing.** A tenant hitting `notFound()` gets Next's bare 404 with no chrome and no way back; an unhandled throw shows "Application error" to a plumber in a driveway. |
| U2 | Emergency flow is entirely `onClick` — safety instructions do not exist until hydration | `CONFIRMED` — 9 handlers | **FIXED (R-098).** Category choice and safety screen are server-rendered and URL-driven; only the final details form is a client component, and it is a real `<form action>`. An e2e spec runs the whole path with JavaScript disabled. |
| U3 | Vendor "Show code" is `onClick` | `PARTLY` | **Not changed, deliberately.** Revealing a code is a privileged read that writes an audit row; it *should* require a live session rather than working from a cached page. H6's three real defects are fixed. |
| U4 | Vendor proposed time rendered in UTC while messages twenty lines away use `utcToWallClock` | `CONFIRMED` | **FIXED (R-098).** Same defect class as R-036b's entry-window bug — I fixed the admin page and missed the vendor page. Also surfaced the *confirmed* window, which the component was never passed at all: a vendor whose visit had been booked and legally noticed still read "we'll confirm". |
| U5 | Pay screen never states a due date | `PARTLY` — per-charge dates render in the itemisation; the balance block has none | **Fixing** the balance-level due date. PAY-01 names it explicitly. |
| U6 | Every vendor dead end says "call the office" and gives no number | `CONFIRMED` | **FIXED (R-098)** — a `tel:` link from `OPERATIONS_PHONE`, rendering nothing when unset rather than a dead "call us". Cheapest high-value fix in the report. |
| U7 | Tenant home page never says whether they owe anything | `CONFIRMED` | **Fixing.** `lib/portal/nav.ts` argues rent is what tenants open the portal for; the home screen does not honour it. |

## UX — Medium and Low

Recorded in full, worked in batches after the High tier. Highlights:

- **U8** — work-order detail offers nine equally-weighted actions with no next-step hierarchy. `CONFIRMED`.
- **U9** — four more `onClick` toggles gate real work behind hydration; pre-hydration the UI silently only permits the answer the landlord wants (Deny/decline are the hidden ones). `CONFIRMED`, and the framing is right.
- **U11** — `/dashboard`, the post-login landing route, is a placeholder. `CONFIRMED`. Redirect to `/tasks` until R-013.
- **U12** — four `friendlyDate` copies, ~35 raw `toISOString()` sites, and two staff screens rendering UTC in as many words. `CONFIRMED`. Worst instance is in the very file that says "every time on this page is the property's wall clock".
- **U14** — the pay and verify screens break the portal's own stated 16px floor. `CONFIRMED`.
- **U15** — vendor surface is 14px throughout; `EMERGENCY` renders as the least prominent text on the page. `CONFIRMED`.
- **U20** — two destructive actions fire on a single tap (resend vendor link revokes the old one mid-job; cancel task). `CONFIRMED`.
- **U23** — a tenant cannot see when anyone is coming, though `scheduledStart` is on the record the page loads. `CONFIRMED`. Most-asked tenant question; currently a phone call.
- **U24** — work-order scope truncated to 80 chars with the full text nowhere on the detail page. `CONFIRMED`.

---

## What I am deliberately NOT doing

- **`capture="environment"` on photo inputs.** Flagged as forcing the camera and removing "choose an existing photo". Real, but it is a **product decision, not an accessibility defect** — the wizard deliberately wants a photo of the thing in front of the tenant. Filed for the owner rather than changed unilaterally.
- **Backlog IDs in staff-facing copy** (`R-044`, `Built by R-013`). D-10 governs tenant and vendor surfaces only, so nothing is broken. The PRD id in "Warranty status (PROP-06)" is worth stripping; the placeholders stay until their items land.
- **Rebuilding the emergency flow's final step as a server-driven wizard.** U2's fix makes the *safety screen* server-rendered and deep-linkable, which is the part that must survive no-JS. The details form after it can stay a client component.

## A gap in the gate itself

Both reviews independently noted that **nothing asserts where focus lands after a server action**, and that axe's `scrollable-region-focusable` rule only fires when a table actually overflows at the test viewport — so M6 is not reliably caught. A single shared e2e assertion (focus is not `body` after an action completes) would have caught most of the High tier and would stop it returning. Added as part of this work.

---

## Already correct — do not undo

Both reviews independently flagged these as load-bearing. Several were expensive to arrive at and are easy to "clean up" into bugs:

- **`components/leases/ledger-panel.tsx`** — `<caption>`, `scope="col"`, reversal spelled out in text rather than colour, credit balance rendered as "in credit" rather than a negative. Best-written table in the app.
- **`app/portal/(signed-in)/layout.tsx`** — viewport with no `maximumScale`/`userScalable` (pinch-zoom deliberately preserved), the 16px floor, 44px targets, and the reasoning written where it is inherited.
- **`components/portal/portal-nav.tsx`** — `aria-current` plus weight plus a border, never colour alone.
- **`components/form/field.tsx`** — `FieldError` with `role="alert"` and a computed `aria-describedby`. This is the component the newer forms should have used and mostly did not.
- **`components/auth-form.tsx`** — the alert-for-failure / status-for-confirmation split, stated correctly.
- **`components/portal/maintenance/verify-panel.tsx`** — two equally weighted submit buttons working before hydration, with "No" deliberately not demoted.
- **`components/workorders/schedule-form.tsx`** — the override field that does not exist until the server says the window is non-compliant, and the `key`-based value echo that stops React 19 clearing the form on the one submit where the user is already being told something is wrong.
- **`components/workorders/close-panel.tsx`** — the explicit "this job cost nothing" checkbox rather than a `$0` default, and `cause` defaulting to `unknown`.
- **`components/shell/property-switcher.tsx`** — a native `<select>` over a combobox. Only the `disabled`/`onChange` wrapper needs changing.
- **`app/(admin)/layout.tsx`** — global search as a plain GET form. Works with no JS, bookmarkable.
- **`app/(admin)/tasks/page.tsx`** — the correct focusable scroll region, and the best screen in the admin.
- **`app/portal/(signed-in)/page.tsx`** — *"you do not have to use this site"* with the phone fallback on the front page.
- **`components/leases/fees-panel.tsx`** — distinguishing "needs two-factor" from "not permitted", so somebody who holds the permission is not shown a screen that looks broken.
