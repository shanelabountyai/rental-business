# Next session

## R-185 (date merge fields) is done and pushed — `79945a0` + `a1b8dc7`.

**CI status: run `34387000785` against `79945a0` was still IN PROGRESS when
this was written.** Do not copy that forward — `gh run list --limit 5` is three
seconds and settles it. R-141's lesson is that this exact sentence gets
inherited instead of run.

R-184's handoff verified run `34381705453` green on both jobs for `cdde562`;
that is history, not this item's gate.

## What R-185 changed that a later session must not silently undo

**D-198. A date merge value is formatted by the VALUE BUILDER, and there are
three of them.** `comms/merge-fields.ts`, `leases/generation.ts` and
`documents/template.ts` are three closed catalogues deliberately sharing one
`renderTemplate`; each has exactly one value builder, and all three had been
writing raw `YYYY-MM-DD`. Eight values now go through `friendlyBusinessDate`.

Three things in that fix are load-bearing:

- **`renderTemplate` was deliberately not touched.** It cannot know which of
  its keys is a date, and a rule that reformats anything matching
  `\d{4}-\d{2}-\d{2}` would apply a date rule to values nobody typed as dates.
- **`generatedOn` stays RAW at its other call sites** in
  `esign-staff-actions.ts` and `documents/generate.ts` — `leaseDocumentBlocks`
  and `documentTemplateBlocks` format it themselves, and the generated file
  name wants a sortable day. That is why the fix is per-value, not
  per-variable. Wrapping the variable would double-format the meta line.
- **`merge-fields.test.ts` refuses an ISO `example` in any of the three
  catalogues.** That test is the guard against the next field reintroducing
  this; it is not decoration.

## The backlog's next row, and what is left of R-184's walk

Row 172 is R-185, ✅. Still true from R-183/R-184's handoffs:

- **Rows 81 (R-081) and 97 (R-097) are SPLIT-PARENT placeholders.** Every child
  shipped. Ticking them is bookkeeping, not work.
- **Row 93 (R-093) is externally blocked** — real vendor drivers, each needing
  a signed commercial relationship. Not a laptop item.

**The best-named unowned item is the second half of R-184's walk: the demo
seed's two defects.** Both are invisible except on a walk, both are seed-only,
and one is the screen an owner would demo:

1. Every `LeaseEnvelope` in `rental_demo` has `draftDocumentId` null, so
   `/sign/[token]` shows a guarantor a signature form with **nothing to read**.
   Production cannot reach that state — `generateLeaseDocument` writes the
   Document and the envelope in one transaction — so the fix is in the seed.
2. `--reset` re-renames rows it has already renamed, so the database holds ten
   generations of `Bluebonnet Lane House (retired …) (retired …) (retired …)`
   and those raw ISO timestamps leak into the vendor and inspection-template
   pickers.

Model for that one: **Sonnet**. It is a seed script with a clear reproduction
and no money, security or jurisdiction path.

Also still open: **commission a fresh operator review** — the 2026-09-05 one is
spent, and R-184's walk is the only thing that has refilled the list since.
That one is Opus.

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a change
touches a form control or page layout (D-194), and now also whenever a page
renders a user-supplied VALUE (D-197). The second kind hides from an
element-by-element probe — no bounding rect exceeds the viewport, because the
box stays inside and the unbreakable text paints past it. Only
`document.documentElement.scrollWidth` sees it.

**Use `npm run test:e2e`, never bare `npx playwright test`.** R-184 did the
latter once and got 28 failures in 0–222ms with no `DATABASE_URL`, which reads
exactly like the jetsam symptom CLAUDE.md warns about and is not it.

**Prove a new assertion against the reverted fix** (D-197, and R-185 did it).
An assertion that still passes with the fix removed is worth nothing, and this
is cheap: `npm run test:e2e -- <spec> -g "<title>"` is about 30 seconds.

## Leftovers still owned by nobody

From R-185: `packages/core` can test the catalogue EXAMPLES but not the values
— the three builders are `server-only` Prisma modules in `apps/web` and no unit
test reaches any of them, so `term.starts_on` and two of the three `today`s are
covered by nothing but `npm run build` and review. `rent.due_day` still renders
as a bare `'1'` rather than `'the 1st'`, left alone deliberately (a
day-of-month is not a date; `friendlyBusinessDate` would throw on it).

From R-184: `leaseStatusLabel` now has tests and its `/money` caller does not
(nothing seeds a `MONTH_TO_MONTH` lease with Stripe sync rows); `from
{prospect.source}` prints the raw column, so the prospect header reads
"Applied · from zillow"; `/workorders/[id]/timeline` was the one route family
the phone-width pass skipped, because it is a route handler and renders no
page.

From R-183: no accrual engine, no interest rate on `JurisdictionRule`, and
`Deposit.escrowAccountRef` / `interestAccruedCents` are still written by
nothing — deliberate, and not to be started until a property in such a state is
onboarded. A bonded tenancy in an interest state shows no obligation on the
lease panel while the state-level gap is still listed.

From R-182: `noticePeriodCheck` (LEASE-12) and `renewalCheck` (LEASE-09) still
count calendar days whatever `dayCountBasis` says — they subtract two `Date`s,
and fixing them is R-042's bug class. `assessEvidence`'s presumption period
takes no basis. Nothing seeds a holiday list for any state.

From R-181: a texted-in tenant never gets the quotable reference; the
acknowledgement rides the hourly outbox cron so it can lag an hour;
`entry.notice` names no ticket; no e2e walks intake → acknowledgement.

From R-180: nothing records the inter-entity transfer; no processing fee, so no
net payout can be stated; `HAP_ACH` would be counted as a Stripe settlement if
anything wrote it. **Stripe Connect is the real answer**, explicitly not built
— needs a legal-structure decision marked *needs counsel*.

From R-179: a guarantor gets a PORTAL chase with no portal inbox; guarantor
consent cannot be recorded, so D-190's SMS suppression is permanent;
`CHASE_LADDER_DAYS` has nowhere to configure it. **`e2e/leases.spec.ts` still
flakes on its own cleanup** — `unit.deleteMany` refuses on
`WorkOrder_unitId_fkey` because R-178's lease-end opens six work orders and the
delete races the async writer. It will keep flaking CI.

From R-178: no `cases.stalled` Task links to its subject; a turn that stalls,
resumes and stalls again is flagged once; `TURN_STAGE_DAYS` unconfigurable;
`draftPunchListFromInspection` findings are unstaged.

From R-177: the R-032c "was this fixed?" SMS default and the TCPA question are
owner decisions, recorded and unfixed. Email-intake tickets get no clarify
link; `e2e/maintenance-phone-log.spec.ts` cleans up by collected-id list.

From R-176: nothing warns portfolio-wide that a unit was listed with an open
re-key; a CANCELED re-key reads like one that never happened.

From R-175: no e-sign on a payment plan agreement; no tenant-facing view of the
schedule.

From R-174: a manager holding a `job_failed` task cannot open `/jobs` to act on
it; nothing tests `jobHealth()` directly.

From R-173: a tenant with a phone but no email still gets a live PORTAL row and
cannot sign in.

From R-172: no staff field for a real handover date on an inherited tenancy;
`apps/web/lib/turnover/queries.test.ts` cleans up by collected-id list.

From R-171: `writePayment` dedups only on `stripePaymentIntentId`, so an ACH
payment may write both a `PENDING` and a `SETTLED` row. Recorded as **unknown**
— verify against real Stripe.

From R-170a: `/staff/new` and `/staff/[id]` each take ~21s to axe-scan against
`/staff`'s 2.2s.
