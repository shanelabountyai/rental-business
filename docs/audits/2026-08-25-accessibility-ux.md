# Accessibility & UX audit — 2026-08-25

**What this is.** A full-codebase WCAG 2.1 AA and usability audit of the rental
operations platform, run by five parallel agents against five surface scopes.
Each finding carries a file and line, who it blocks, the WCAG criterion, the
concrete failure, and the smallest fix.

**Why it exists.** The product's own acceptance criteria say WCAG 2.1 AA is a
gate on tenant- and vendor-facing work, "not a later cleanup". 596 e2e tests,
2,740 unit tests and 88 routes returning 200 had never once been checked against
that criterion by something reading for it.

**Status: complete.** All five scopes ✅ — vendor+auth, tenant portal,
maintenance+ops, shared UI layer, money+leasing.

## By the numbers

| | |
|---|---|
| Findings | **75** across 5 scopes |
| Routes covered | 88 |
| Defects traced to **one shared component** | 3 (`SubmitButton`, `--ring`, `--input`) |
| Files reached by the `SubmitButton` fix | **108** |
| Hand-rolled live regions that announce nothing | **37** |
| Files of `dark:` CSS that can never render | **86** |
| Worst measured focus-ring contrast | **1.00:1** (required: 3:1) |
| Worst measured input-border contrast | **1.26:1** (required: 3:1) |
| Findings that automated tooling would catch | few — most pass axe |

---

# Part 1 — Post-ready angles

Each of these is a self-contained story with a number in it. Ranked by how well
it travels.

## ① Two independent auditors found the same invisible input border

`--input` is `oklch(0.922 0 0)` — about `#e5e5e5` — on a white page. That is
**1.26:1**. WCAG needs 3:1 for a UI boundary. The field has no fill contrast
either, so the border is the *only* thing marking where to type, and it is
effectively invisible on a phone outdoors.

`--ring`, the focus indicator on every control in the product, is **2.59:1**.

> **The hook:** shadcn's default token. Thousands of apps ship it. It fails the
> criterion the moment you measure it, and nobody measures it because it *looks*
> fine on the laptop it was designed on.

**Lesson:** design tokens are the highest-leverage accessibility defect there
is. One line fixes every field and every focus ring in an 88-route app. One line
broke them.

**Evidence:** [globals.css:21-23](apps/web/app/globals.css#L21-L23)

---

## ② Every `dark:` class in the codebase is dead CSS

**FIXED (R-111).** All 243 `dark:` utilities across 76 files deleted, along with `@custom-variant dark` and the `.dark` palette. `globals.css` now opens with a comment saying the product is light-only and what it would take to change that. The audit understated it: R-107a had already *measured and fixed* a 1.64:1 contrast bug in the dark `--input` — real work, on CSS that could not render.


`@custom-variant dark (&:is(.dark *))` — and nothing in the app ever sets a
`dark` class or reads `prefers-color-scheme`.

Dozens of components carry carefully-chosen `dark:text-red-400` /
`dark:bg-amber-950` pairings. **None of them can ever apply.** The product is
light-only while the code reads as though both modes ship.

> **The hook:** the audit that reviews your dark-mode contrast is reviewing CSS
> that will never render.

**Lesson:** a theme you never wired up is worse than no theme — it makes every
future reviewer confident about a surface that does not exist.

---

## ③ The one screen written for a phone has its one button as an `onClick`

The vendor gate-code reveal. A contractor standing at a locked door on mobile
data taps "Show code" — and it does nothing until the JS bundle finishes
loading.

The kicker: an earlier item rewrote the three buttons directly above it
(accept / propose / decline) into real `<form action>` elements for precisely
this reason, wrote a comment explaining why, and left this one.

> **The hook:** the fix was already in the file. Eleven lines up.

**Lesson:** "we fixed that pattern" is a claim about a diff, not about a
codebase. The next instance arrives from an author who read the fix and not the
rule.

**Evidence:** [vendor-job.tsx:417-424](apps/web/components/vendors/vendor-job.tsx#L417-L424)

---

## ④ The tenant's primary job doesn't work without JavaScript, and says nothing

**FIXED (R-112).** Every step of the wizard is a real `<form method="get">` with the answers in the URL, Next and Back are submit buttons, and `reachableStep` clamps whatever arrives to the furthest step the answers support. Photos are the one part still needing JavaScript — a file cannot travel in a query string — and say so in a `<noscript>`. **Proven by walking the whole flow with `javaScriptEnabled: false`** and asserting the ticket that comes out carries every answer: it is the carrying between steps that breaks first, not the rendering.


A seven-step maintenance-request wizard, entirely `onClick`-driven. Before
hydration: the category radios render and are tappable, "Next" is inert. The
tenant taps, taps again, and **nothing happens, with no message**.

Next door, the *emergency* maintenance path was rewritten to be URL-driven for
exactly this reason, with a comment explaining it. The ordinary path — the one
every non-emergency tenant uses — was left behind.

> **The hook:** the emergency flow is bulletproof. The everyday flow is the one
> that silently fails.

**Lesson:** hardening is drawn to the scary path. The boring path is where the
volume is.

**Evidence:** [maintenance-wizard.tsx:159-179](apps/web/components/portal/maintenance/maintenance-wizard.tsx#L159-L179)

---

## ⑤ Twenty controls named "Condition" on one page

**FIXED (R-112).** The room and item are a `<legend>` on a `<fieldset>` per item, so assistive technology announces them on entering the group. One change in the shared component, reaching the staff walkthrough and the tenant's move-in screen.


A move-in walkthrough is ~20 items. Each renders a select called "Condition", a
field called "Notes", a button called "Save", a file input called "Add a photo",
a button called "Upload".

The `id`s are correctly disambiguated. The **accessible names** are not. Tabbing
the page gives "Condition, combo box" twenty times, with no way to tell the
kitchen sink from the bedroom window. The room name is on screen — as a `<p>`,
associated with nothing.

> **The hook:** it passes every automated checker. `id`s unique, labels present,
> `aria` valid. It is unusable.

**Lesson:** unique `id` is a correctness property. Distinguishable *name* is a
usability one. Linters check the first.

**Evidence:** [inspection-item-form.tsx:161](apps/web/components/inspections/inspection-item-form.tsx#L161)

---

## ⑥ ~20 error messages that announce nothing

`{state.error && <p role="alert">…}` — the live region arrives already
populated. A node that is *inserted* with its text already in it is a new node,
not a change, so screen readers say nothing.

This exact defect was found and fixed twice before, in the two shared primitives
(`FormAlerts`, `FieldError`), each with a long comment explaining it. The
full-codebase count is **37 callers** that hand-rolled the broken shape instead
of importing the fix — a third of the product's forms.

Two of them are payment paths: **a declined card and a failed application fee
are both silent.**

> **The hook:** the fix shipped. Twice. With documentation. And twenty places
> never got it.

**Lesson:** fixing the primitive doesn't fix the callers who never used it. A
grep for the *anti-pattern* is the missing step after every "fixed in the shared
component."

---

## ⑦ The most irreversible thing a tenant can do is a single tap

**FIXED (R-112).** The same `agree` checkbox the lease and inspection signatures use, checked server-side — and `required` in the browser as well, because a server-side refusal empties every uncontrolled field the tenant just typed (R-008). Both layers are tested.


Giving notice to vacate — terminating your own tenancy — is a two-field form and
one button. No review step, no confirmation, no undo. It's two taps from a
"Papers" screen a tenant might be browsing.

Every *other* irreversible action in the product (signing a lease, signing an
inspection) carries an explicit agreement checkbox. This one doesn't.

> **The hook:** we gate the signature. We don't gate the termination.

**Lesson:** friction budgets get spent on what looks legally serious, not on
what is actually hardest to reverse.

**Evidence:** [notice-to-vacate-form.tsx:37](apps/web/components/portal/notice-to-vacate-form.tsx#L37)

---

## ⑧ The public front door is internal build notes

**FIXED (R-114).** `/` is a signpost: the product name, a link to the tenant portal sign-in, a link to staff sign-in, and one sentence telling a vendor their texted link is the way in. The scaffold notes, the backlog path and both worked calculations are gone. A spec asserts both halves — the links resolve, and the words "scaffold" and "docs/prds" appear nowhere — because the absence is what stops the next person restoring a convenient debug panel on the one public URL.

`/` renders "Scaffold only", names a backlog file path, and prints proration and
late-fee-cap arithmetic. There is no link to `/login`. Anyone who bookmarks the
domain or mistypes a vendor link lands there.

> **The hook:** a dead end that also leaks how the product is built.

**Lesson:** the route nobody is assigned is the route nobody reviews.

**Evidence:** [page.tsx:33-56](apps/web/app/page.tsx#L33-L56)

---

## ⑨ A dead magic link lands on a pristine sign-in form

**FIXED (R-114).** `/portal/login` reads the parameter that was already being passed, and answers `invalid` and `missing` separately: links only work once and expire, some email apps open them first, versus some email apps cut long links in half. `autoFocus` on the email field gives way when a message is present — this arrives as a full document load from a route handler, so there is no Next route announcer, and pulling focus into the field would skip the banner for the person who most needs it.

The two commonest magic-link failures — an expired link, and one already burned
by the tenant's own email prefetcher — redirect to `/portal/login?error=…`.

The login page takes no `searchParams` and renders no error. The tenant sees the
identical screen they started on, with no indication anything failed.

The route that issues the redirect has a comment anticipating the prefetcher
case. The page it redirects *to* never read the parameter.

> **The hook:** the error was diagnosed, named, and passed in a query string
> that nothing reads.

**Lesson:** an error channel with no consumer is indistinguishable from no error
handling — and looks handled in code review.

---

## ⑩ The last-resort error page's only recovery needs the JS that just failed

**FIXED (R-114).** `reset` stays — a transient render failure does recover — but it is no longer the only way out: a plain `<a href="/">` that needs no bundle, and `VendorHelpLine`'s `tel:` link, which needs no network. The `<h1>` takes focus, because this boundary also fires client-side with focus sitting on a control that has just ceased to exist. The `no-html-link-for-pages` lint rule is disabled on that one line with the reason written next to it: `next/link` needs the router, which is the thing that just failed.

`global-error.tsx` fires when the root layout throws. Its sole control is
`onClick={reset}`. If the failure is in the bundle, the button does nothing when
pressed and explains nothing. No link home, no phone number, no focus moved.

The vendor error page next to it does all three correctly.

> **The hook:** the fallback for "JavaScript broke" is a JavaScript button.

---

## ⑪ An ISO date on a screen whose file header says "plain language governs every word here"

`Due {charge.dueOn.toISOString().slice(0, 10)}` → "Due 2026-09-01", on the
tenant pay screen. Every other tenant screen uses a `friendlyDate` helper.

`toISOString()` also renders in UTC, so the due date is **off by one for any
property west of UTC** — a date-only-column trap the repo documents twice.

> **The hook:** one call is both an accessibility defect and an off-by-one money
> bug.

---

## ⑫ Focus rings that are white on white

Three buttons use `focus-visible:ring-2` without `focus-visible:ring-ring`.
Tailwind v4 defaults `ring` to `currentColor` — and on a `bg-foreground
text-background` button the current colour is the *background*. White ring,
white offset, white page.

One of them is the primary answer button on "Is your repair fixed?"

---

## ⑬ Every submit button in the app throws keyboard focus to the top of the page

`SubmitButton` does `disabled={pending}`. Disabling the element that currently
has focus moves focus to `<body>` — in every browser. So pressing Enter on
"Close this work order" returns a keyboard user to the top of the document for
the duration of the action, and again when the result renders.

`SubmitButton` is imported by **108 files**, and the pattern is hand-copied at 18 more.

Then the second half: `bg-primary` + `text-primary-foreground` at
`opacity-60` composites to about **2.2:1**. "Working…" — the only feedback the
press produced — is the least readable thing on screen at the exact moment it
matters.

> **The hook:** the accessible thing to do with a pending button is
> `aria-disabled`, not `disabled`. One attribute, forty forms.

**Evidence:** [auth-form.tsx:74-85](apps/web/components/auth-form.tsx#L74-L85)

---

## ⑭ The 3am emergency panel confirms nothing, to nobody

An operator presses "I have this" on a maintenance emergency. The panel replaces
itself with "Acknowledged…" — which means the button that had focus no longer
exists, so focus drops to `<body>`, and the `role="status"` is a brand-new node
carrying its text, so it announces nothing.

The operator gets **no confirmation that the escalation chain stopped** — the one
fact the panel exists to deliver — and is returned to the top of the document.

The helper written for exactly this ("three panels in this product swap their
whole section on success") sits in a file this one already imports from.

> **The hook:** the highest-stakes screen in the product, and the press that
> matters most is the one that says least.

**Evidence:** [emergency-response-panel.tsx:67-91](apps/web/components/maintenance/emergency-response-panel.tsx#L67-L91)

---

## ⑮ A button that says "Nothing due" and is still enabled and still submits

`RunBatchButton` on preventive maintenance. When `dueCount === 0` the label reads
"Nothing due". The button remains enabled and remains wired to an action that
creates work orders across every property in scope.

> **The hook:** a control that states there is nothing to do, and then does
> something.

---

## ⑯ "Send" with no idea how many people it reaches

The announcement composer texts and emails every tenant matching a segment. It
never says how many that is. There is no confirmation step; the per-recipient
results table only renders *after* the send.

The default segment is **All tenants** — so the highest-blast-radius option is
the one a mis-click lands on.

> **The hook:** the fix isn't a modal. It's putting the number in the button:
> "Send to 34 tenants."

---

## ⑰ Two buttons named "Send" — one texts the tenant, one texts the vendor

Any work order with both parties renders "Message the tenant" and "Message the
vendor" in the same section. Both submit buttons are named `Send`. The `<h3>`s
above them are not part of either button's accessible name.

> **The hook:** by ear, these two controls are the same control. They are not.

---

## ⑱ The on-call rota is stated in the wrong timezone

Five staff screens render times with `toLocaleString` and no `timeZone`, or as
raw `toISOString()`. On Vercel that means UTC.

"You are on call until Fri 11:00" is, for an on-call rota, a materially wrong
statement. And the messages inbox shows a UTC stamp for the same message the
thread page shows property-local — **so opening a conversation changes the time
on it.**

> **The hook:** a project with `friendlyDate` and `utcToWallClock` helpers, and
> five screens that call neither.

---

## ⑲ A focus ring at exactly 1.00:1

Thirteen primary buttons carry `bg-foreground text-background … focus-visible:ring-2
focus-visible:ring-offset-2 focus-visible:outline-none` — and no `ring-ring`.

Tailwind v4 defaults `--tw-ring-color` to **`currentcolor`** and
`--tw-ring-offset-color` to **`#fff`**. On a `text-background` button
`currentColor` *is* the background. So: a white ring, behind a white offset gap,
on a white page. **1.00:1** — while `outline-none` has already removed the
browser's own indicator.

A keyboard user has no way to tell where they are. These are the submit buttons
for chargebacks, announcements, emergency response, and the tenant's "was this
fixed?" panel.

> **The hook:** not "low contrast". Not "hard to see". Mathematically, exactly,
> invisible.

**Lesson:** the auditor compiled the project's Tailwind to confirm the v4
defaults rather than trusting the docs. That step is the whole finding — the
class list *looks* like it has a focus ring.

**Evidence:** [chargeback-panel.tsx:115](apps/web/components/workorders/chargeback-panel.tsx#L115) and 12 more

---

## ⑳ The celebrated fix might be a no-op across 113 files, and no test could tell you

Every live region in this product is `<div role="status" className="contents">`.
`display: contents` removes the element's box — and browsers have a long history
of also removing such elements from the **accessibility tree**.

Fixed in current Chromium and Gecko. Fixed later in WebKit. And iOS Safari with
VoiceOver is the tenant portal's primary target.

By the code's own account this has never been checked with a screen reader. If
the assumption is wrong, the fix everyone was pleased about is inert in 113
files — and there is no automated test that could surface it, because the DOM is
correct either way.

> **The hook:** the auditor flagged this as *"the one finding I cannot settle by
> reading"* and refused to call it a defect. That's the honest version.

**Lesson:** an accessibility fix isn't done when the code is right. It's done
when someone has heard it work.

---

## ㉑ The automated a11y tests are configured not to report it

**FIXED (R-111).** One `axeScan()` in [e2e/fixtures.ts](../../e2e/fixtures.ts) replaces 60 hand-written `AxeBuilder` chains across 40 spec files, with `best-practice` in the tag set. **Proven by making it fail**: restoring the nested `<main>` turned the scan red on THREE rules the old filter hid — `landmark-main-is-top-level`, `landmark-no-duplicate-main`, and `landmark-unique`, which the audit did not name. The nested `<main>` itself is gone from `/portal/pay/history`.


A page renders `<main>` nested inside `<main>`. Invalid HTML, two main landmarks,
and the skip link's `#main` now targets the wrong element.

The suite runs axe on it and passes. Why: `landmark-no-duplicate-main` and
`landmark-main-is-top-level` are tagged `best-practice`, and every `AxeBuilder`
in the repo filters to `wcag2a|wcag2aa|wcag21a|wcag21aa`.

> **The hook:** the tag filter that makes an a11y suite "focused on what matters"
> is the same filter that made this invisible.

**Lesson:** know what your scanner's default tag set excludes. "axe passes" is a
statement about a configuration, not about a page.

---

## ㉒ The primary navigation is announced as supplementary content

**FIXED (R-111).** The `<aside>` in `app/(admin)/layout.tsx` is a `<div>`. The `<nav aria-label="Sections">` inside it was already carrying the semantics, so nothing was added.


The admin section nav lives in an `<aside>`, which maps to
`role="complementary"`. A landmark-navigating screen-reader user hears
"complementary → navigation, Sections" and moves past the primary means of
getting around the app.

The `<nav aria-label="Sections">` inside it is already doing all the semantic
work. The fix is deleting one wrapper element.


---

## ㉓ "Upload the photos below." There is no below. There is no upload.

The inherited-lease intake panel lists what's missing on a tenancy the owner
acquired at closing. One gap is the condition baseline, and it instructs:
*"Upload the photos below."*

There is no upload control below it. The "Condition as found" list renders only
when photos already exist — which is exactly false while the gap is open.

Then the real finding: `CONDITION_BASELINE_DOCUMENT_TYPE` is **written by no
route and no action anywhere in the app.** It is read in one query and set in
tests. There is no way to close this gap from the product.

> **The hook:** the one panel whose entire job is naming the next action names
> one that cannot be taken.

**Lesson:** a read path and a write path can be built by different items months
apart, and only the read path has a screen. Grep your enum for its writer.

**Evidence:** [intake-panel.tsx:112-118](apps/web/components/leases/intake-panel.tsx#L112-L118)

---

## ㉔ Three buttons named "Open the case"

On the lease detail page: gone-dark case, confidential case, violation case.
Three very different legal acts, three identical accessible names.

This is the exact collision class the project's own house rules document at
length, with four prior instances named. It landed twice more.

The auditor ran a **full pairwise check across all 113 labels, legends,
summaries and button names** on the assembled page. These were the only exact
duplicates — plus one substring: a bare "Add" sitting inside "Add guarantor",
"Add somebody to the lease", "Add this charge" and "Forwarding address".

> **The hook:** documenting a trap doesn't close it. Only a check does — and the
> check took one agent one pass.

---

## ㉕ A one-time code, shown once, announced never

An operator issues a door access code for a tenant. The form unmounts to display
the code — so the focused button is destroyed, focus falls to `<body>`, and the
action returns the code with no notice text, so there is nothing for a live
region to carry even if one had survived.

A blind operator presses the button, hears silence, lands at the top of the
document, and **the one-time code is now unreachable.**

**Evidence:** [issue-code-button.tsx:21-27](apps/web/components/leases/issue-code-button.tsx#L21-L27)

---

## ㉖ The fair-housing warning appears silently

Choosing "Unauthorized animal" on the violation form inserts a warning that
serving a notice on an assistance animal is a fair-housing complaint.

It is inserted into the DOM with no live region. A screen-reader user choosing
that option is told nothing.

The same panel's neighbour is worse: ticking a checkbox **renames** the reason
field and **renames the submit button** — "Lift all controls" becomes "Apply
these controls" — with no announcement. The control someone is sitting on
changes identity underneath them.

> **The hook:** the most legally consequential sentence on the screen is the one
> nobody hears.

---

## ㉗ A fair-housing report with a column called "Fees charged" and a column called "Charged"

One is a count ("2 of 5"). One is a sum ("$150.00"). A screen reader announces
the header with each cell, so a row reads *"Fees charged, 2 of 5"* then
*"Charged, $150.00"*. "Charged" is also a substring of "Fees charged", so neither
name identifies its column.

This is the late-fee **distribution** report — the one table where misreading
which number is which is the entire point of the table.

**Evidence:** [waiver-pattern.tsx:49-50](apps/web/components/money/waiver-pattern.tsx#L49-L50)


---

# Part 2 — Full findings

## Scope: vendor & public entry ✅

### 1. Four vendor/public forms announce nothing on success, and drop focus to `<body>`
- **FIXED (R-114).** All five (the audit found four; `verify-link-form.tsx` is the fifth). Each replaced panel now opens with a heading carrying `tabIndex={-1}`, focused through `useFocusWhen` on client action state, and every `FormAlerts` was hoisted out of the branch whose render condition the action changes. **The real find**: R-107b's comment on `listing-inquiry-form.tsx` claimed the region was "mounted from first paint"; the early `return` replaces the whole form, so it never was.
- **Where:** [vendor-job.tsx:279](apps/web/components/vendors/vendor-job.tsx#L279), [:500](apps/web/components/vendors/vendor-job.tsx#L500); [bid-form.tsx:47-53](apps/web/components/vendors/bid-form.tsx#L47-L53); [verify-link-form.tsx:39-49](apps/web/components/portal/verify-link-form.tsx#L39-L49); [listing-inquiry-form.tsx:23-29](apps/web/components/listings/listing-inquiry-form.tsx#L23-L29)
- **Blocks:** screen-reader, keyboard-only · **WCAG:** 4.1.3, 2.4.3
- The action changes the very condition its result region renders under. Accepting a job flips `job.vendorResponse`, so `{!answered && <FormAlerts/>}` unmounts and "Thanks — the office has been told." renders nowhere. Same for `markWorkComplete`, `submitBid`, and `submitInquiry`. The focused button unmounts, so focus falls to the top of the document.
- **Fix:** `useFocusWhen` already exists in [auth-form.tsx:129](apps/web/components/auth-form.tsx#L129). Give each replaced panel an `<h2 tabIndex={-1}>` and focus it on `Boolean(state.notice)`. For the vendor page the confirmation must come from the server-rendered branch, not from `useActionState` state the re-render discards.

### 2. Every input boundary and focus ring under 3:1 — see angle ①
- **Where:** [globals.css:22-23](apps/web/app/globals.css#L22-L23), consumed by [field.tsx:54](apps/web/components/form/field.tsx#L54), [auth-form.tsx:65](apps/web/components/auth-form.tsx#L65)
- **WCAG:** 1.4.11 · `--input` ≈1.27:1, `--ring` ≈2.6:1
- **Fix:** darken `--input` to ≥3:1 (~`oklch(0.72)`); same for `--ring`.

### 3. Vendor gate-code reveal is `onClick` — see angle ③
- **FIXED (R-114).** A real `<form action>` with the id in a hidden field, one `useActionState` for the whole section so revealing a second code does not blank the first, and `markWorkComplete` moved to the `(state, formData)` signature so it is a server action reference rather than an inline arrow. **Proven with `javaScriptEnabled: false`**: accept the job, reveal the code, both with no bundle.
- **Where:** [vendor-job.tsx:417-424](apps/web/components/vendors/vendor-job.tsx#L417-L424), [:107-110](apps/web/components/vendors/vendor-job.tsx#L107-L110)
- Also: wrapping the complete action in an inline arrow at `:107` means React cannot emit a form endpoint into the HTML, so "Mark the work finished" is also dead pre-hydration — the press submits a bare GET and is silently lost.
- **Fix:** real `<form action>` with the id in a hidden field. Change `markWorkComplete` to the `(state, formData)` signature.

### 4. The reveal failure message is a live region inserted with its text
- **FIXED (R-107b)**, and R-114 additionally rebuilt `bid-form.tsx`'s decline toggle, which the audit did not name: it was a `useState` `onClick`, so before hydration the only answer a vendor could give was a price. It is a `<details>` with its own form now, like the dispatch page's three.
- **Where:** [vendor-job.tsx:382-386](apps/web/components/vendors/vendor-job.tsx#L382-L386) · **WCAG:** 4.1.3
- A vendor refused a code (expired link, job not theirs) is told nothing.
- **Fix:** mount unconditionally with `className="contents"`, like `FieldError`.

### 5. "Show code" is not contained in its own accessible name
- **FIXED (R-114).** The visible text is `Show code for the {name}` and the `aria-label` is gone, so there is one name rather than two. Three assertions in `vendor-link.spec.ts` moved with it.
- **Where:** [vendor-job.tsx:417-424](apps/web/components/vendors/vendor-job.tsx#L417-L424) · **WCAG:** 2.5.3
- Visible text "Show code"; `aria-label` "Show the Front door code". Speech input matching "Show code" hits nothing.
- **Fix:** reorder to `Show code for the ${name}`. Specs at `e2e/vendor-link.spec.ts:377,389,463` move with it.

### 6. Listing photos are marked decorative
- **FIXED (R-114)**, as the interim the audit describes: `Photo N of M of {address}`. A caption field written by whoever uploads the photo is still the proper answer and belongs with the uploader.
- **Where:** [listings/[id]/page.tsx:87-98](apps/web/app/listings/[id]/page.tsx#L87-L98) · **WCAG:** 1.1.1
- `alt=""` on the primary content of a rental listing. A blind prospect gets rent, beds and disclosures, and no acknowledgement a gallery exists. `Document` has no caption column.
- **Fix (interim):** `alt={`Photo ${i+1} of ${n} — ${addressLine1}`}`. A real caption field is the proper answer.

### 7. A validation error empties every field just typed
- **FIXED (R-114)** at the root rather than per form. `VendorFormState` and `InquiryFormState` carry `values`, echoed on every refusal — including the ones that fire before parsing, which lose exactly as much typing. `defaultValue` alone does not survive React 19's post-dispatch reset, so `property-form.tsx`'s R-008 remount was extracted as `useFormVersion` and applied to all four; its comment carries the warning that live regions must stay outside the keyed form.
- **Where:** [listing-inquiry-form.tsx:31-63](apps/web/components/listings/listing-inquiry-form.tsx#L31-L63); [bid-form.tsx:54-76](apps/web/components/vendors/bid-form.tsx#L54-L76); [vendor-job.tsx:448-490](apps/web/components/vendors/vendor-job.tsx#L448-L490). Root cause: `VendorFormState` and `InquiryFormState` carry no `values`.
- React 19 resets uncontrolled fields after a form action. Submit the inquiry with neither email nor phone and all five fields come back blank. The repo already solved this — `state.values` echoed back — in `lease-form.tsx`, `renewal-panel.tsx`, `property-form.tsx`.

### 8. The bid dead end says "call the office" and gives no number
- **FIXED (R-114).** `VendorHelpLine` on both the invalid-link page and the already-answered panel.
- **Where:** [vendor/bid/[token]/page.tsx:36](apps/web/app/vendor/bid/[token]/page.tsx#L36); [bid-form.tsx:49](apps/web/components/vendors/bid-form.tsx#L49)
- `VendorHelpLine` was built for exactly this and renders a `tel:` link. The bid surface, added by the same programme, still prints the sentence the component replaced.

### 9. Reveal has no pending state, and each repeat tap writes an audit row
- **FIXED (R-114)** by the form conversion above: `SubmitButton` brings the pending label and the click guard with it.
- **Where:** [vendor-job.tsx:122-127](apps/web/components/vendors/vendor-job.tsx#L122-L127)
- On mobile data a vendor taps three or four times; the access log for a single door reads as four separate reveals.

### 10. Two controls share a name on one assembled page
- **FIXED (R-114).** The inquiry button is "Send my question"; the vendor message button is "Send this message".
- [listings/[id]/page.tsx:163](apps/web/app/listings/[id]/page.tsx#L163) `<h2>Ask about this listing` vs [listing-inquiry-form.tsx:63](apps/web/components/listings/listing-inquiry-form.tsx#L63) `SubmitButton label="Ask about this listing"` — announced twice with different roles.
- [vendor-job.tsx:325](apps/web/components/vendors/vendor-job.tsx#L325) "Send this time" vs [:572](apps/web/components/vendors/vendor-job.tsx#L572) "Send" — substring collision, latent only because no spec does it yet.

### 11. `/` is internal build notes — see angle ⑧
### 12. `global-error.tsx` recovery needs the JS that failed — see angle ⑩
### 13. Every `dark:` variant unreachable — see angle ②

### 14. Inline links on the phone-first vendor surface are ~20px tall
- **FIXED (R-114).** `inline-flex min-h-11 items-center` on all three.
- **Where:** [vendor-job.tsx:215-222](apps/web/components/vendors/vendor-job.tsx#L215-L222), [:250-252](apps/web/components/vendors/vendor-job.tsx#L250-L252), [:230](apps/web/components/vendors/vendor-job.tsx#L230) · **WCAG:** 2.5.8
- The file's own standard is `min-h-11` on every control. These three text links get nothing, on the screen written for a gloved hand.

---

## Scope: tenant portal ✅

### 1. The maintenance wizard doesn't work without JS — see angle ④
- **Where:** [maintenance-wizard.tsx:159-179](apps/web/components/portal/maintenance/maintenance-wizard.tsx#L159-L179), and every `NextButton`/`Back`/`Send request` at 317, 362, 423, 492, 527, 580, 612
- **Fix:** URL-driven steps as the emergency page already does (`?step=prompts&category=PLUMBING`), or at minimum a `<noscript>` pointing at `/portal/messages` and the phone number.

### 2. Step transitions move no focus and announce nothing
- **Where:** [maintenance-wizard.tsx:183](apps/web/components/portal/maintenance/maintenance-wizard.tsx#L183) and the seven `{step === '…'}` blocks · **WCAG:** 2.4.3, 4.1.3
- Pressing Next unmounts the step including the focused button. `useFocusWhen` was written for exactly this case and the largest instance in the product does not use it.

### 3. Twenty identically-named controls on the walkthrough — see angle ⑤
- **Where:** [inspection-item-form.tsx:161,170,177,202,207](apps/web/components/inspections/inspection-item-form.tsx#L161)
- **Fix:** one change in the shared component — `<fieldset>` per item with the room/item text as `<legend>` — fixes both the staff and tenant screens.

### 4. `/portal/pay/history` renders a second `<main>` inside the layout's `<main>`
- **Where:** [pay/history/page.tsx:40](apps/web/app/portal/(signed-in)/pay/history/page.tsx#L40), [:50](apps/web/app/portal/(signed-in)/pay/history/page.tsx#L50) vs [layout.tsx:90](apps/web/app/portal/(signed-in)/layout.tsx#L90) · **WCAG:** 1.3.1
- Two nested `main` landmarks; the skip link's `#main` is no longer the only main. It also double-applies width and padding, so this one page is visibly narrower than every sibling. The only page in the portal that does it.

### 5. Troubleshooting radio groups have no accessible name
- **Where:** [maintenance-wizard.tsx:381-391](apps/web/components/portal/maintenance/maintenance-wizard.tsx#L381-L391) · **WCAG:** 1.3.1, 4.1.2
- A `<legend>` only names its group when it is the fieldset's **first child**. Here it sits two `<div>`s deep, so it names nothing — and several steps on one screen each present "I tried this" / "Skip this" with no group name. The file's own comment asserts the fieldset/legend "was already correct".

### 6. White-on-white focus ring on the primary tenant action — see angle ⑫
- **Where:** [verify-panel.tsx:135](apps/web/components/portal/maintenance/verify-panel.tsx#L135), [:101](apps/web/components/portal/maintenance/verify-panel.tsx#L101)

### 7. `--border`/`--input` at 1.26:1 — see angle ①
### 8. `--ring` at 2.59:1 — see angle ①

### 9. Eight tenant-facing error regions mounted with their text — see angle ⑥
- **Where:** [portal-reply-form.tsx:21](apps/web/components/portal/portal-reply-form.tsx#L21), [maintenance-wizard.tsx:288](apps/web/components/portal/maintenance/maintenance-wizard.tsx#L288), [verify-panel.tsx:155](apps/web/components/portal/maintenance/verify-panel.tsx#L155), [add-photo-form.tsx:45](apps/web/components/portal/maintenance/add-photo-form.tsx#L45), [emergency-details-form.tsx:71](apps/web/components/portal/maintenance/emergency-details-form.tsx#L71), [autopay-panel.tsx:75,150,237](apps/web/components/payments/autopay-panel.tsx#L75), [fee-payment.tsx:57,101](apps/web/components/applications/fee-payment.tsx#L57), [document-upload-form.tsx:36](apps/web/components/applications/document-upload-form.tsx#L36), [prescreen-form.tsx:95](apps/web/components/prospects/prescreen-form.tsx#L95)

### 10. A dead magic link lands on a pristine sign-in page — see angle ⑨
- **Where:** [portal/verify/route.ts:19,27](apps/web/app/portal/verify/route.ts#L19); [portal/login/page.tsx:24](apps/web/app/portal/login/page.tsx#L24) · **WCAG:** 3.3.1
- `lib/portal/guard.ts:37` sends an expired session to the same silent page.

### 11. Giving notice to vacate has no confirmation — see angle ⑦

### 12. An ISO date on the pay screen — see angle ⑪
- **Where:** [pay/page.tsx:128](apps/web/app/portal/(signed-in)/pay/page.tsx#L128)

### 13. The portal's own 16px floor is broken on the money screens and the notice body
- **Where:** [notices/[id]/page.tsx:63](apps/web/app/portal/(signed-in)/notices/[id]/page.tsx#L63) (the notice text itself, `<pre … text-sm>`); [pay/history/page.tsx:94,100,137,166](apps/web/app/portal/(signed-in)/pay/history/page.tsx#L94); [pay/page.tsx:99,104,110,121,127](apps/web/app/portal/(signed-in)/pay/page.tsx#L99); [notices/page.tsx:26,33,52](apps/web/app/portal/(signed-in)/notices/page.tsx#L26); [verify-panel.tsx](apps/web/components/portal/maintenance/verify-panel.tsx) throughout
- The layout states the rule in as many words: "`text-base` everywhere, never `text-sm` … a tenant portal is read by people of every age on every handset." The two worst instances are the two that matter most — **the full text of a served legal notice renders at 14px in a monospace `<pre>`**, and payment history renders at 14px with 12px headers.

### 14. Every photo's "Remove" button has the same accessible name
- **Where:** [maintenance-wizard.tsx:467-473](apps/web/components/portal/maintenance/maintenance-wizard.tsx#L467-L473) · **WCAG:** 2.4.6

### 15. File-upload controls show no focus indicator
- **Where:** [maintenance-wizard.tsx:441-454](apps/web/components/portal/maintenance/maintenance-wizard.tsx#L441-L454); [add-photo-form.tsx:30-43](apps/web/components/portal/maintenance/add-photo-form.tsx#L30-L43) · **WCAG:** 2.4.7
- The `<input>` is `sr-only` inside a styled `<label>`, and `focus-visible:ring-*` is on the *label*. Focus goes to the input, so the ring never paints. The wizard's own `OPTION_BUTTON` solves this correctly with `focus-within:ring` and explains why.

### 16. Photo upload progress and failure are never announced
- **Where:** [maintenance-wizard.tsx:462-466](apps/web/components/portal/maintenance/maintenance-wizard.tsx#L462-L466); [add-photo-form.tsx:31](apps/web/components/portal/maintenance/add-photo-form.tsx#L31) · **WCAG:** 4.1.3
- A failed photo on a maintenance request is evidence lost, silently.

---

## Scope: maintenance & operations ✅

### 1. `--ring` at 2.59:1 is the *only* focus indicator in the admin shell
- **Where:** [globals.css:23](apps/web/app/globals.css#L23), consumed by `focus-visible:ring-ring` on essentially every control · **WCAG:** 1.4.11
- Every focusable control pairs the ring with `focus-visible:outline-none`, so the grey ring is the sole signal. Light mode only; dark passes at ~4.2:1.

### 2. `--input` at 1.26:1, plus five hand-rolled copies of `INPUT_CLASSES`
- **Where:** [globals.css:21-22](apps/web/app/globals.css#L21-L22); hand-rolled at [reply-form.tsx:56](apps/web/components/comms/reply-form.tsx#L56), [timeline-section.tsx:147,169](apps/web/components/workorders/timeline-section.tsx#L147), [log-phone-request-form.tsx:69](apps/web/components/maintenance/log-phone-request-form.tsx#L69), [create-work-order-form.tsx:86](apps/web/components/workorders/create-work-order-form.tsx#L86)

### 3. Repeated row controls all carry the same accessible name
- **Where:** [inspection-item-form.tsx:161-177,202-207](apps/web/components/inspections/inspection-item-form.tsx#L161) (worst); [delete-form.tsx:47-49,64-69](apps/web/components/documents/delete-form.tsx#L47) + [restore-button.tsx:17](apps/web/components/documents/restore-button.tsx#L17) per row; [run-batch-button.tsx:22](apps/web/components/maintenance/run-batch-button.tsx#L22) per template; [timeline-section.tsx:215-220](apps/web/components/workorders/timeline-section.tsx#L215) · **WCAG:** 2.4.6, 4.1.2
- The `idPrefix`/`rowId` machinery solved the duplicate-**id** bug and stopped there. **It is a destructive action in two of the four.**
- **Fix:** fold the row's name into the control's own label — `Delete ${fileName}`, `Run ${template.name} batch (3 due)`.

### 4. Two buttons named "Send" on the assembled work-order page — see angle ⑰
- **Where:** [reply-form.tsx:84](apps/web/components/comms/reply-form.tsx#L84) and [timeline-section.tsx:149](apps/web/components/workorders/timeline-section.tsx#L149), composed at [workorders/[id]/page.tsx:564](apps/web/app/(admin)/workorders/[id]/page.tsx#L564)

### 5. Thirteen more hand-rolled live regions mounted with their text
- **Where:** `reply-form.tsx:58-66`, `log-call-form.tsx:44-52`, `emergency-response-panel.tsx:146-150`, `log-phone-request-form.tsx:71-79`, `on-call-toggle.tsx:76-80`, `close-panel.tsx:145-149`, `create-work-order-form.tsx:88-92`, `preference-toggle.tsx:50-54`, `upload-form.tsx:61-65`, `inspection-template-form.tsx:65-69`, `rule-form.tsx:381-385,488-492`, `property-form.tsx:140-142` · **WCAG:** 4.1.3
- Running total across three scopes: **~33 instances of the same defect.** Submitting a triage reply, a call log, an emergency vendor toggle or a work-order close with a validation error is silent.
- `on-call-toggle.tsx:35` shows the correct shape already, in the same file as one of the broken ones.

### 6. The emergency acknowledge panel — see angle ⑭

### 7. The approval panel's Deny/Ask disclosure unmounts the button just pressed
- **Where:** [approval-panel.tsx:173-201](apps/web/components/workorders/approval-panel.tsx#L173-L201) vs [:144-171](apps/web/components/workorders/approval-panel.tsx#L144-L171) · **WCAG:** 2.4.3, 4.1.3
- Pressing "Deny" sets `mode` and removes itself; the required "Why not?" field it reveals renders *above* where the button was, with no focus move and no announcement. Both toggles are `onClick` — dead on first paint — on a panel whose stated requirement is "approve from a phone in ≤2 taps".
- **Fix:** `<details>`/`<summary>`, which survives its own activation and works without JS — the pattern `fees-panel.tsx:56` already documents for the same reason.

### 8. Three controls do their whole job in `onChange`
- **Where:** [preference-toggle.tsx:40-49](apps/web/components/notifications/preference-toggle.tsx#L40-L49) (`requestSubmit()`, no submit button at all — pre-hydration the checkbox flips visually and nothing saves, post-hydration nothing is announced); [announcement-form.tsx:73-86](apps/web/components/messages/announcement-form.tsx#L73-L86) (controlled `<select>` — before hydration only "All tenants" is reachable); [property-switcher.tsx:41-56](apps/web/components/shell/property-switcher.tsx#L41-L56) in the header of every admin page (sets `disabled={pending}` on the focused `<select>`, dropping focus mid-interaction)

### 9. `<dt>`/`<dd>` outside any `<dl>`
- **Where:** [job-panel.tsx:40-43](apps/web/components/workorders/job-panel.tsx#L40-L43) · **WCAG:** 1.3.1
- The tech reading a job on a phone hears a bare phone number with no label. Every sibling panel gets this right; this one instance was missed.

### 10. The announcement composer — see angle ⑯
### 11. Times in the server's timezone — see angle ⑱
- **Where:** `maintenance/[id]/page.tsx:110-115`, `account/page.tsx:72-76`, `announcements/history/page.tsx:78` (`toLocaleString`, no `timeZone`); `messages/page.tsx:114`, `notifications/page.tsx:~101` (raw `toISOString()` labelled "UTC")

### 12. `SubmitButton`'s `disabled={pending}` — see angle ⑬
- Hand-copied at `close-panel.tsx:153`, `chargeback-panel.tsx:114`, `emergency-response-panel.tsx:84,130`

### 13. Destructive and bulk actions fire on a single press
- **Where:** [tasks/[id]/page.tsx:223](apps/web/app/(admin)/tasks/[id]/page.tsx#L223) ("Cancel task", directly under "Mark complete" — a mis-aimed press on a phone cancels the task with no undo path); [delete-form.tsx:64-69](apps/web/components/documents/delete-form.tsx#L64-L69); [run-batch-button.tsx:22](apps/web/components/maintenance/run-batch-button.tsx#L22) — see angle ⑮

### 14. Thirteen `<summary>` disclosure targets at 20-24px
- **Where:** `messages/[id]/page.tsx:158,180`, `documents-section.tsx:97`, `operational-data-section.tsx:100,136,165,194`, `filing-cabinet-section.tsx:161,188,224,244,276,320`, `reports/reserves/page.tsx:170` · **WCAG:** 2.5.8
- The codebase applies `min-h-11` to summaries elsewhere, so this is a convention thirteen instances missed. "Log a phone call" and "Export this conversation" are the two a PM reaches for from a driveway.

### 15. Section titles as styled paragraphs; the work-order action block has no heading at all
- **Where:** [workorders/[id]/page.tsx:404-487](apps/web/app/(admin)/workorders/[id]/page.tsx#L404-L487) · **WCAG:** 1.3.1, 2.4.6
- The block holding **eight action buttons and three forms** (assign, schedule, actuals, mark complete, dispatch, warranty hold) is an unlabelled `<div>` between "Bids" and "Closed". Navigating by heading skips straight past every control that changes the job's state.

### 16. The maintenance request detail never states the ticket's priority
- **Where:** [maintenance/[id]/page.tsx:79-102](apps/web/app/(admin)/maintenance/[id]/page.tsx#L79-L102)
- The `<dl>` lists Status, Source, Unit, Tenant, Entry permitted, Pet at home. **Priority is absent** — though the page branches on `priority === 'EMERGENCY'` twenty lines earlier. An URGENT ticket is visually identical to a ROUTINE one on the one screen that exists to confirm a request landed with the right fields.
- Adjacent: work-order `scope.slice(0, 80)` renders with no ellipsis and no full text anywhere, so a truncated scope reads as a complete sentence that stops mid-word.

---

## Scope: shared UI layer ✅

*The highest-leverage scope — one defect here reaches every screen. This auditor
compiled the project's Tailwind to confirm v4 ring defaults and computed every
contrast ratio rather than estimating.*

### 1. Focus indicator at 1.00:1 on 13 primary buttons — see angle ⑲
- **Where:** [chargeback-panel.tsx:115](apps/web/components/workorders/chargeback-panel.tsx#L115), `announcement-form.tsx:130`, `verify-panel.tsx:135`, `translations-panel.tsx:60,199`, `template-editor.tsx:143`, `rent-roll-table.tsx:157`, `emergency-response-panel.tsx:85`, `close-panel.tsx:154`, `messages/templates/page.tsx:65`, `inspections/page.tsx:26`, `inspections/templates/page.tsx:33`, `documents/templates/page.tsx:28` · **WCAG:** 2.4.7 (A) — outright failure
- **Fix:** all 13 are the same hand-rolled copy of one button. Give `auth-form.tsx` a `<PrimaryButton>` and delete the duplication, so the ring class cannot be forgotten a 14th time.

### 2. `--ring` at 2.59:1, and the global outline fallback at 1.54:1
- **Where:** [globals.css:23](apps/web/app/globals.css#L23) · **WCAG:** 1.4.11
- `#a1a1a1` on `#ffffff` = 2.59:1. Every control also sets `focus-visible:outline-none`, so this ring is the only indicator, and `ring-offset-2` puts a white gap on the inner edge too. On the dark `bg-primary` button it is 6.91:1 — the failure is exactly on the light surfaces, which is most of the app.
- **Worse:** the `@layer base { * { @apply outline-ring/50 } }` at [globals.css:69](apps/web/app/globals.css#L69) computes to **1.54:1** — and it is load-bearing for `CheckboxField`, which sets no focus classes of its own.
- **Fix:** `oklch(0.55 0 0)` (`#767676`) = 4.6:1 on white and still reads on the dark primary button. Drop the `/50`.

### 3. `SubmitButton` blurs focus on every submit — see angle ⑬
- **Where:** [auth-form.tsx:74-85](apps/web/components/auth-form.tsx#L74-L85); imported by **108 files**; hand-rolled at 18 more (`chargeback-panel.tsx:113`, `translations-panel.tsx:198`, `template-editor.tsx:142`, `property-switcher.tsx:45`, …) · **WCAG:** 4.1.3, 2.4.3
- The full picture: focus is thrown to `<body>` on every form press; the visible text swaps to "Working…" but a disabled, unfocused button with no live region and no `aria-busy` announces **nothing**; when the action returns, `FormAlerts` announces into a region the user is no longer near — and for actions that redirect or only revalidate, nothing is said at all.
- **Fix:** `aria-disabled={pending} aria-busy={pending}` + an `onClick` guard, `disabled:opacity-60` → `aria-disabled:opacity-60`. Focus stays on the button, so the name change to "Working…" *is* announced. Fixing it here fixes 108 files.

### 4. 37 live regions mounted together with their text — see angle ⑥
- Full list in the agent transcript; representative sites span the portal reply form, emergency details, photo uploader, autopay panel, application fee payment, jurisdiction rule form, renewal panel, billing runs, vendor job, record-invoice form.
- **Fix:** mechanical sweep. No new code — `FieldError` and `LiveRegion` already exist and already mount unconditionally with `display: contents`, in components that already import from the same file.

### 5. Every field boundary at 1.26:1 light — and the dark values are worse
- **Where:** [globals.css:21-22](apps/web/app/globals.css#L21-L22) · **WCAG:** 1.4.11
- `#e5e5e5` on `#ffffff` = **1.26:1** against a required 3:1. These fields have no fill and no underline, so the border is the only thing identifying an input as an input. **Dark is worse:** `oklch(1 0 0 / 15%)` composites to **1.47:1** over the background and **1.57:1** over `--card`; `--input` at 18% gives **1.64:1**.
- **Fix:** `--border: oklch(0.75 0 0)` reaches 3:1 on white; dark alphas need roughly `/ 40%`. Or split the token — hairlines vs control boundaries, which is what 1.4.11 actually distinguishes.

### 6. Six inputs marked invalid without saying why
- **Where:** [upload-form.tsx:53,62](apps/web/components/documents/upload-form.tsx#L53), [document-upload-form.tsx:28,37](apps/web/components/applications/document-upload-form.tsx#L28), [translations-panel.tsx:182](apps/web/components/comms/translations-panel.tsx#L182), [delete-form.tsx:49](apps/web/components/documents/delete-form.tsx#L49), [timeline-section.tsx:141,163](apps/web/components/workorders/timeline-section.tsx#L141) · **WCAG:** 1.3.1, 3.3.1
- Each sets `aria-invalid` with no `aria-describedby`, and the error `<p>` carries no `id`. The field announces "invalid" and the reason is orphaned prose. **Both document uploaders are the tenant/applicant-facing ones.**

### 7. 86 files of unreachable `dark:` styling — see angle ②
- **Where:** [globals.css:4](apps/web/app/globals.css#L4), `:26-43`; [app/layout.tsx:14-15](apps/web/app/layout.tsx#L14-L15)
- No `next-themes`, no `ThemeProvider`, no `prefers-color-scheme` rule, no `color-scheme` on `<html>`. A user whose OS is in dark mode — often itself a low-vision accommodation — gets `oklch(1 0 0)` pure white with no way out.
- **Fix:** pick one. Delete the dead variants, or change to `@custom-variant dark (@media (prefers-color-scheme: dark))` and add `color-scheme: light dark`. Half-wired is the worst of both.

### 8. `<main>` nested inside `<main>`, and why the suite passes it — see angle ㉑
- **Where:** [pay/history/page.tsx:40,50](apps/web/app/portal/(signed-in)/pay/history/page.tsx#L40) inside [layout.tsx:90](apps/web/app/portal/(signed-in)/layout.tsx#L90)

### 9. The property switcher navigates on change, disables itself, says nothing
- **Where:** [property-switcher.tsx:45-54](apps/web/components/shell/property-switcher.tsx#L45-L54) · **WCAG:** 4.1.3, 2.4.3
- On every admin screen. `disabled={pending}` blurs the control the user is standing on; when the refresh lands, every number on the page has changed and nothing announces it. **In Firefox, arrowing through the options triggers a scope change and a focus loss per keystroke.**

### 10. `CheckboxField` has no focus styling and a 20px target
- **Where:** [field.tsx:234](apps/web/components/form/field.tsx#L234) · **WCAG:** 1.4.11, 2.5.8
- The only control in the shared layer with no `focus-visible:` classes at all, so it falls back to the global `* { outline-ring/50 }` rule at **1.54:1**. `size-5` is under the 24px minimum; the `<label>` extends the hit area, which is what saves it in practice.
- **Fix:** one line, every checkbox in the product.

### 11. Primary navigation inside a `complementary` landmark — see angle ㉒
- **Where:** [(admin)/layout.tsx:86-88](apps/web/app/(admin)/layout.tsx#L86-L88)

### 12. ⚠️ VERIFICATION ITEM: `display: contents` on all three live-region primitives — see angle ⑳
- **Where:** [auth-form.tsx:151,184,191](apps/web/components/auth-form.tsx#L151); [field.tsx:43](apps/web/components/form/field.tsx#L43)
- Reported as a verification item, not a defect. **Settle it with VoiceOver on iOS and NVDA on Windows** — submit a form, confirm the error is spoken. If it fails, the zero-cost alternative is a normal block with `empty:hidden` rather than `contents`.

---

## Scope: money & leasing ✅

### 1. Two tenants, one DOM id — the second field has no accessible name at all
- **Where:** [door-codes-panel.tsx:126](apps/web/components/leases/door-codes-panel.tsx#L126), rendered once per tenant from line 83 · **WCAG:** 1.3.1, 3.3.2, 4.1.1
- `RevokeForm` passes a **constant** `idPrefix="door-code"`, so `TextField` builds `id="field-door-code-reason"` for every tenant on the lease. `<label htmlFor>` resolves to the first one only; clicking the second tenant's label focuses the wrong input.
- `holds-panel.tsx:101` gets this right with `idPrefix={\`lift-${hold.id}\`}` — this one just never got the interpolation.

### 2. Issuing an access code — see angle ㉕
- **Where:** [issue-code-button.tsx:21-27](apps/web/components/leases/issue-code-button.tsx#L21-L27); same shape at [door-codes-panel.tsx:103-113](apps/web/components/leases/door-codes-panel.tsx#L103-L113) · **WCAG:** 4.1.3, 2.4.3
- `issueTenantLockCode` returns `{ code }` with no `notice`, so the action would need changing too, not just the component.

### 3. `--ring` at 2.58:1, and `outline-ring/50` at 1.54:1 on eight `<summary>` elements
- **Where:** [globals.css:23](apps/web/app/globals.css#L23), [globals.css:69](apps/web/app/globals.css#L69) · **WCAG:** 1.4.11
- Fourth independent confirmation. *"The screens are otherwise scrupulous about focus rings, so the indicator is present everywhere and visible almost nowhere."*

### 4. Eight per-row panels give every row identically-named controls
- **Where:** [payment-hold-panel.tsx:126,136](apps/web/components/leases/payment-hold-panel.tsx#L126) (the `sr-only` legend covers only the three checkboxes — the reason field and submit button sit **outside** the fieldset); [accommodations-panel.tsx:210,271,282](apps/web/components/accommodations/accommodations-panel.tsx#L210); [parties-panel.tsx:89](apps/web/components/leases/parties-panel.tsx#L89); [claim-panels.tsx:207](apps/web/components/insurance/claim-panels.tsx#L207); [billing-runs.tsx:118](apps/web/components/billing/billing-runs.tsx#L118); [screening-decision-form.tsx:37,59](apps/web/components/screening/screening-decision-form.tsx#L37); [prospects/[id]/page.tsx:151,266](apps/web/app/(admin)/prospects/[id]/page.tsx#L151); [deposit/page.tsx:148](apps/web/app/(admin)/leases/[id]/deposit/page.tsx#L148) · **WCAG:** 2.4.6, 4.1.2
- *"A screen-reader user hears 'Remove, Remove, Remove', and pressing one deletes a deduction or denies an accommodation with no way to tell which."*
- **The repo already solved this twice:** `fees-panel.tsx:67` names the row in the control ("Waive this late fee of $50"); `payment-hold-panel.tsx:66` uses an `sr-only` legend. For the payment-hold case the fix is literally moving the closing `</fieldset>` down past two elements.

### 5. Three "Open the case" buttons and two "Why (required)" fields — see angle ㉔
- **Where:** [abandonment/open-case-panel.tsx:71](apps/web/components/abandonment/open-case-panel.tsx#L71), [confidential/open-case-panel.tsx:131](apps/web/components/confidential/open-case-panel.tsx#L131), [violations/open-case-panel.tsx:140](apps/web/components/violations/open-case-panel.tsx#L140); [holds-panel.tsx:76](apps/web/components/holds/holds-panel.tsx#L76) vs [payment-hold-panel.tsx:126](apps/web/components/leases/payment-hold-panel.tsx#L126)
- **"Why (required)" needs no disclosure opened** — both forms show it on load.
- **Fix:** the `<summary>` above each already says the right words. "Open a gone-dark case" / "Open a confidential case" / "Open a violation case".

### 6. A validation error that is neither announced nor associated
- **Where:** [evictions/case-panels.tsx:60-62](apps/web/components/evictions/case-panels.tsx#L60-L62) (no `role`, no `id`, no `aria-describedby` — the §3931 default-judgment question's error is red text and nothing else); [record-invoice-form.tsx:117-121](apps/web/components/vendor-invoices/record-invoice-form.tsx#L117-L121); [renewal-panel.tsx:117-121](apps/web/components/leases/renewal-panel.tsx#L117-L121) — **the rent-cap refusal, the one message on that form somebody must not miss** · **WCAG:** 3.3.1, 4.1.3

### 7. Revealed content is never announced, including the fair-housing warning — see angle ㉖
- **Where:** [violations/open-case-panel.tsx:99-107](apps/web/components/violations/open-case-panel.tsx#L99-L107) and `:108-121`; [holds-panel.tsx:66-73](apps/web/components/holds/holds-panel.tsx#L66-L73); [accommodations-panel.tsx:220-256](apps/web/components/accommodations/accommodations-panel.tsx#L220-L256); [payment-hold-panel.tsx:125,136](apps/web/components/leases/payment-hold-panel.tsx#L125) · **WCAG:** 4.1.3

### 8. `--input` at 1.26:1 — on a field somebody types a dollar figure into
- **Where:** [globals.css:22](apps/web/app/globals.css#L22) · **WCAG:** 1.4.11

### 9. Three invoice split lines repeat five identical field names
- **Where:** [record-invoice-form.tsx:123-167](apps/web/components/vendor-invoices/record-invoice-form.tsx#L123-L167) · **WCAG:** 1.3.1, 3.3.2
- "Property", "Category", "Amount", "What this line was for", "Work order ID" — three times over, separated only by an `<h3>Line 1</h3>` inside a plain `<div>`, which conveys nothing programmatically. *"Splitting a $900 bill across the wrong property is a Schedule E error nobody notices until January."*
- **Fix:** `<div>` → `<fieldset>`, `<h3>` → `<legend>`. Nested fieldsets are valid and the outer one already exists.

### 10. Rent-roll row checkboxes are a 20px target
- **Where:** [rent-roll-table.tsx:191-199](apps/web/components/money/rent-roll-table.tsx#L191-L199) · **WCAG:** 2.5.8
- The checkbox that decides whether a tenant gets a collection reminder. The "select all" control directly above it is correctly wrapped in a `min-h-11` label; the per-row ones were missed.

### 11. "Upload the photos below" — see angle ㉓

### 12. Every `dark:` variant unreachable — see angle ②
- Fourth independent confirmation. *"Every dark contrast pairing in this codebase is unexercised, so whenever dark mode is switched on it ships untested."*

### 13. "Fees charged" and "Charged" — see angle ㉗

### 14. `SubmitButton` disables itself on press — see angle ⑬
- Third independent confirmation, this time framed by consequence: *"a screen-reader user pressing 'Record this payment' gets silence and a lost cursor while the write is in flight."*

### 15. The waiver reason is required by the server and marked required nowhere
- **Where:** [fees-panel.tsx:80-87](apps/web/components/leases/fees-panel.tsx#L80-L87) · **WCAG:** 3.3.2
- The comment on line 77 says "REQUIRED, and the action refuses without it". The hand-rolled `<input>` has neither `required` nor `aria-required`; the only hint is a `placeholder`, which disappears on focus. The user finds out by being refused.

### 16. Two irreversible actions commit on a single press
- **Where:** [finalize-disposition-form.tsx:28](apps/web/components/deposits/finalize-disposition-form.tsx#L28); [parties-panel.tsx:86-92](apps/web/components/leases/parties-panel.tsx#L86-L92)
- The deposit page says in prose *"This cannot be undone once the letter exists"* — and the button next to that sentence fires on one press with no acknowledgement step. `party-change-panel.tsx:222` has an explicit "I have read the warning above" checkbox for a comparable act.
- **Fix for "Remove":** name the person in the button ("Remove Dana Ruiz from the lease"), which closes finding 4 at the same time.

---

# Part 3 — What was checked and found sound

Recorded so the next audit knows what not to re-read.

**Vendor & auth:** all four auth pages are real `<form action>` with no `onClick`
and none are prerendered, so the nonce/CSP hazard does not apply · `auth-form.tsx`
primitives (`Field`, `SubmitButton`, `FormAlerts`, `LiveRegion`, `useFocusWhen`) ·
`form/field.tsx` label association and always-mounted `FieldError` ·
`vendor-job.tsx`'s three-form accept/propose/decline block (native `<details>`,
works with no JS) · `vendor/[token]/error.tsx` (the model for `global-error.tsx`) ·
colour is never the sole signal anywhere in scope · byte-serving routes both go
through `documentResponse`.

**Tenant portal:** the signed-in layout (skip link, landmarks, pinch-zoom left
enabled, 44px sign-out) · `portal-nav.tsx` (`aria-current`, three redundant
signals) · the **emergency maintenance flow**, the best-built flow in scope —
URL-driven so safety instructions exist on first paint, correct fieldset/legend,
a third "I am not sure" answer, nothing pre-checked · portal `error.tsx` and
`not-found.tsx` · `pay-form.tsx` (fee disclosed before the choice, in a mounted
`LiveRegion`) · the six token pages, each a single `<main>`, `robots: noindex`,
no `loading.tsx` in any segment, rejections that do not confirm a record exists ·
every tappable control at 44px+ · all non-token colour pairings clear 4.5:1 in
both modes.

**Maintenance & ops:** `form/field.tsx` primitives (the baseline is right; the
findings are callers bypassing it) · `FormAlerts`, `LiveRegion`, `useFocusWhen` ·
the admin layout's skip link, single `<main id="main">`, labelled search ·
`shell/nav.tsx` (`aria-current`, 44px, colour not the only signal) · admin
`error.tsx` focuses its `<h1>` · **every `<table>` in scope** uses `<th scope="col">`
and the scrollable ones use the `role="region" aria-label tabIndex={0}` pattern ·
`<dl>` usage in the five report pages is the HTML-permitted `display:contents`
form · **the entire dark palette passes** — `--muted-foreground` 8.9:1, `--input`
4.4:1, `--ring` 4.2:1, and every badge pair clears 4.5:1 · no `<div onClick>`
anywhere in the admin tree.

*Flagged outside scope:* `components/turnover/turnover-panel.tsx` has six
unscoped `<th>`.

**Shared UI layer:** all 11 `LiveRegion` call sites mount unconditionally and
populate later — `rent-roll-table.tsx:86-101` correctly hoists the region
*outside* the panel whose render condition the action can change · all three
`useFocusWhen` consumers put `tabIndex={-1}` on the ref target so the
programmatic focus actually lands · `TextField`/`TextareaField`/`SelectField`
error association is correct, including the dangling-reference case · **every
text pairing passes in both palettes** (light: foreground 19.79:1,
muted-foreground 7.44/6.82:1, destructive 4.76:1, error red-900-on-red-50
9.21:1; dark: foreground 18.96:1, and every badge pair 10:1+) · both layouts put
a real skip link first in the DOM targeting a real `<main id="main">`, and
neither contains a heading, so neither can break heading order · portal viewport
deliberately allows pinch-zoom · `aria-current="page"` paired with a weight
change and a bar rather than colour alone · `PropertySwitcher` is a native
`<select>` with `<optgroup>`, not a custom combobox · **zero `<div onClick>`,
zero `role="button"`, zero icon-only buttons anywhere in the shared layer** — the
product imports no icons at all — and every mutation is a real `<form action>`.

**Money & leasing:** landmarks and headings across **all 20 routes** — every page
exactly one `<h1>`, every panel a `<section aria-labelledby>` pointing at a real
`<h2>`, no level skipped · **no `<div onClick>` anywhere in scope**; the single
in-scope `onClick` is a documented progressive enhancement over three
server-rendered lines · `rent-roll-table.tsx` apart from the checkbox target —
`sr-only` caption, `scope="col"` on every header, header/cell counts reconcile,
live region deliberately mounted outside the panel its action can unmount ·
`fees-panel.tsx` and `recurring-panel.tsx` use `<details>`/`<summary>` rather
than a `useState` toggle, so the control survives its own activation, **and are
the model the other eight per-row panels should copy** · `notices/[id]` clean
throughout · every status pill and warning banner carries text, never hue alone.

---

# Part 4 — If you fix five things

Ranked by reach, not by severity. The first three are one-line token or
component changes that close a defect on every screen in the product.

1. **`--ring` → `oklch(0.55 0 0)`, `--input` → `oklch(0.72 0 0)`** ([globals.css:21-23](apps/web/app/globals.css#L21-L23)) — closes the focus-indicator and field-boundary failures app-wide. Drop the `/50` from the base `outline-ring` rule while you're there.
2. **`SubmitButton`: `disabled` → `aria-disabled` + `aria-busy`** ([auth-form.tsx:74-85](apps/web/components/auth-form.tsx#L74-L85)) — 108 files stop throwing keyboard focus to `<body>`, and "Working…" starts being announced.
3. **Add `focus-visible:ring-ring` to the 13 white-on-white buttons** — or better, promote them to a shared `<PrimaryButton>` so there is no 14th.
4. **Sweep the 37 hand-rolled `{error && <p role="alert">}` blocks** onto the existing `FieldError` / `LiveRegion`. Mechanical, no new code, and it is the single largest count in the audit.
5. **Verify `display: contents` with a real screen reader** (angle ⑳). Until someone has heard it, items 2–4 and R-101's original fix all rest on an untested assumption.

Then decide the dark-mode question once (angle ②), because 86 files are currently
neither shipped nor deleted.
