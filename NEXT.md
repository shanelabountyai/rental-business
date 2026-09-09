# Next session

## R-186 (the demo seed's two walk-only defects) is done and pushed — `34a4d8b` + `0b638c3`.

**CI is IN FLIGHT at handoff.** A monitor was armed on `34a4d8b`, the commit
carrying every code change, and the result had not landed when this was
written. **Do not copy this line forward** — run `gh run list --limit 5` and
read it yourself. R-141's lesson is that this exact sentence gets inherited
instead of run, and R-140's own entry claimed CI could not have run on a push
that had in fact failed.

`0b638c3` is docs-only and correctly has no run: `.github/workflows/ci.yml`
carries `paths-ignore: ['**.md', 'docs/**']`.

## What R-186 changed that a later session must not silently undo

**D-199. Every rename `--reset` performs has to survive being run twice.**
`reset()` retires properties first and legal entities LAST, and finds
everything it owns through `ENTITY_NAMES` — so a run that dies in between
leaves the entity findable under its original name, and the next run retires
the same properties again. `retiredName` is now the single writer for all five
renames (property, vendor, PM template, inspection template, legal entity) and
appends at most once. `retirementStamp` writes demo-zone wall time in words.

- **The stamp is read off a screen.** `/vendors`, `/properties` and
  `/inspections/templates` all list inactive rows deliberately, so
  `2026-09-09T16:51` was D-153's class one item after D-198 fixed it in the
  merge catalogues. The clock stays: idempotence is per RUN, not per day.
- **`rental_demo` still holds the pre-fix debris** — eleven generations of
  doubled names. Inert (inactive, renamed out of the by-name search) and not
  cleaned up by the fix.

**D-200. The seed borrows the product's renderers and duplicates only the
values.** `writeLeaseDraftDocument` uses `leaseDocumentBlocks`
(`@rental/core/leases`) and `renderBlocksPdf` (`apps/web/lib/pdf`, through
`registerWebModuleHooks` — extracted from `loadBillingPipeline`, which had the
`server-only` / `@/` resolve hooks inline).

- **The duplicate is kept honest by a test, not a comment.**
  `demo-seed.test.ts` renders `seed-lease-templates.mts`'s own `LEASE_BODY`
  through `demoLeaseMergeValues` and asserts nothing is missing and no value
  reaches the page as `YYYY-MM-DD`. A field added to the template that the seed
  cannot fill **throws** on the next `--reset`.
- **Nothing in `apps/web` changed, and that is the finding.**
  `generateAndSendLease` writes the Document and the envelope in one
  transaction, so production could never reach the null `draftDocumentId`
  state. A defect only the seed can produce is fixed in the seed.
- **Signer order is one-based now**, in both the document and the
  `LeaseSigner` rows — `orderedSigners` always was, and the seed's own loop
  counted from 0, so the demo's PDF read "Tenant 0".

## The backlog's next row

Row 173 is R-186, ✅. Still true from earlier handoffs:

- **Rows 81 (R-081) and 97 (R-097) are SPLIT-PARENT placeholders.** Every child
  shipped. Ticking them is bookkeeping, not work.
- **Row 93 (R-093) is externally blocked** — real vendor drivers, each needing
  a signed commercial relationship. Not a laptop item.

**The best-named unowned item is now the one R-183/R-184/R-185 have each
deferred: commission a fresh operator review.** The 2026-09-05 one is spent,
R-184's walk was the only thing that has refilled the list since, and R-186
just closed the last item that walk named. Nothing else in the file has an
owner. Model for that one: **Opus** — it is judgement about product direction,
not a build.

The `e2e/leases.spec.ts` cleanup flake below is the other defensible pick, and
it is the one thing on this list that costs CI time on every push.

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a change
touches a form control or page layout (D-194), and now also whenever a page
renders a user-supplied VALUE (D-197). The second kind hides from an
element-by-element probe — only `document.documentElement.scrollWidth` sees it.

**Use `npm run test:e2e`, never bare `npx playwright test`.** R-184 did the
latter once and got 28 failures in 0–222ms with no `DATABASE_URL`, which reads
exactly like the jetsam symptom CLAUDE.md warns about and is not it.

**Prove a new assertion against the reverted fix** (D-197; R-185 and R-186 both
did it). An assertion that still passes with the fix removed is worth nothing,
and it is cheap — for a unit test it is one `perl -0pi -e` and 600ms.

**A seed defect is only visible on a walk.** R-186's two were both invisible to
every test in the repo, and the sign-page one was only provable by starting
`npm run dev:demo` and fetching the token URL. D-28 is not a formality.

## Leftovers still owned by nobody

From R-186: the demo's lease term is `startsInDays + termMonths * 30`, so a
twelve-month lease reads *30 Sept 2026 to 25 Sept 2027* on the document a
guarantor reads closely; the seeded draft has **no utilities and no addenda**,
so two blocks the real generator produces are never shown; the staff-side
`/leases/[id]` e-sign panel was not walked in a browser, only the
token-authorized page; and `storageIsRemote` skips the draft document entirely,
so with `BLOB_READ_WRITE_TOKEN` set the defect returns.

From R-185: `packages/core` can test the catalogue EXAMPLES but not the values
— the three builders are `server-only` Prisma modules in `apps/web` and no unit
test reaches any of them. (R-186 adds a fourth builder, `demoLeaseMergeValues`,
and that one IS tested — it is the only one that is.) `rent.due_day` still
renders as a bare `'1'` rather than `'the 1st'`, left alone deliberately.

From R-184: `leaseStatusLabel` now has tests and its `/money` caller does not;
`from {prospect.source}` prints the raw column, so the prospect header reads
"Applied · from zillow"; `/workorders/[id]/timeline` was the one route family
the phone-width pass skipped.

From R-183: no accrual engine, no interest rate on `JurisdictionRule`, and
`Deposit.escrowAccountRef` / `interestAccruedCents` are still written by
nothing — deliberate, and not to be started until a property in such a state is
onboarded.

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
