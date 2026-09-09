# Next session

## R-184 (the Milestone 10 demo walk) is done and pushed — `cdde562` + `8be7214`.

**CI is GREEN on both jobs** — run `34381705453` against `cdde562`, the commit
carrying every code change: *Lint, types, unit tests, build* and *End-to-end,
axe, Lighthouse* both passed. Checked with `gh run view`, not assumed. **Do not
copy this line forward** — re-check with `gh run list --limit 5` before
trusting it, because R-141's lesson is that this exact sentence gets inherited
instead of run.

**The two docs-only commits (`8be7214`, `e0bab41`) have no CI run, and that is
correct.** `.github/workflows/ci.yml` carries `paths-ignore: ['**.md',
'docs/**']`. If you compare against R-183, whose *"record the SHA"* commit DID
get a run despite being markdown-only: that commit was pushed in the same
`git push` as its code commit, so the push event's diff contained code and the
run took its title from the head commit. R-184 pushed each commit separately,
so the skip is the rule working, not a pipeline that stopped.

## The backlog still has no next row, and that has not changed

R-183's handoff explained this and it still holds:

- **Rows 81 (R-081) and 97 (R-097) are SPLIT-PARENT placeholders.** Every child
  shipped. Ticking them is a deliberate bookkeeping call, not work.
- **Row 93 (R-093) is externally blocked** — real vendor drivers, each needing
  a signed commercial relationship. Not a laptop item.
- Row 171 is R-184, ✅, this walk.

**The walk itself is now the best source of a next item.** It produced two
named, unowned defects and neither is trivia:

1. **The merge-field catalogue renders raw `YYYY-MM-DD` into real tenant
   email.** Seen in context this time: the template preview shows *"rent … is
   due on 2026-10-01"* and the subject *"Rent for Bluebonnet Lane House is due
   2026-10-01"*. `template-values.ts` builds `lease.starts_on`,
   `lease.ends_on` and `balance.due_on` with `utcToBusinessDate` /
   `dueDateOnOrAfter` and nothing formats them after that. This is D-153's
   class and R-179 named it first; it is catalogue-wide, so it wants its own
   item rather than a patch. **The preview panel cannot catch it** — it
   correctly flags a merge field with *nothing* behind it (it caught
   `{{balance.total}}`), and a field with the wrong *format* behind it looks
   fine to it.
2. **The demo seed has two defects of its own**, both invisible except on a
   walk. Every `LeaseEnvelope` in `rental_demo` has `draftDocumentId` null, so
   `/sign/[token]` shows a guarantor a signature form with nothing to read —
   production cannot reach that state (`generateLeaseDocument` writes the
   Document and the envelope in one transaction), so this is seed-only, but it
   is the screen an owner would demo. And `--reset` re-renames rows it has
   already renamed, so the database holds ten generations of
   `Bluebonnet Lane House (retired …) (retired …) (retired …)` and those raw
   ISO timestamps leak into the vendor and inspection-template pickers.

Also still open: **commission a fresh operator review** — the 2026-09-05 one is
spent, and this walk is the only thing that has refilled the list since.

Model: recommend at the start of whatever gets picked, per the global
convention. The merge-field item is a correctness/formatting sweep across a
catalogue — Opus.

## What R-184 changed that a later session must not silently undo

**D-196. `requireScope` now distinguishes "no permission" from "no proved
second factor"** and redirects the latter to `/account?mfa=required`, the same
destination `requirePermission` has always used. It is checked BEFORE the
scope check on purpose: `propertyScope` collapses an unproved second factor
into an empty scope, so after that call the two cases are indistinguishable.
`/no-access` deliberately gained no `mfa_required` branch — nothing routes
there with that reason any more.

**D-197. A hyphen is a line-break opportunity and a dot is not.** The reflow
fixture in `prospects.spec.ts` is `marcus.aurelius.antoninus.<hex>@…` and the
dots are load-bearing. An earlier version with a hyphen was *longer* than the
real address that exposed the defect and passed with the fix reverted.

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a change
touches a form control or page layout (D-194) — and now also whenever a page
renders a user-supplied VALUE (D-197). The second kind hides from an
element-by-element probe: no bounding rect exceeds the viewport, because the
box stays inside and the unbreakable text paints past it. Only
`document.documentElement.scrollWidth` sees it.

**Use `npm run test:e2e`, never bare `npx playwright test`.** R-184 did the
latter once and got 28 failures in 0–222ms with no `DATABASE_URL` — which
reads exactly like the jetsam symptom CLAUDE.md warns about, and is not it.

## Leftovers still owned by nobody

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
