# Next session

## R-205 is done. Pick up R-206 — it is the other half of the same root.

R-205 shipped as `958b499` (SHA recorded in `e082064`). **CI run
`34855784822` is GREEN on both jobs** — `Lint, types, unit tests, build` and
`End-to-end, axe, Lighthouse` — read on the run itself once it completed, not
copied forward. Do not copy this line forward either: `git rev-parse` a short
SHA before `gh run list --commit`, which returns empty for a short one with no
error.

**Start here:** `docs/prds/06-backlog.md` → row 193 / **R-206**. The review
that sourced the arc is verbatim at
`docs/reviews/2026-09-13-operator-review.md`; D-222 records the decision and
the binding "do not build" list, and **D-223 is R-205's own** — read it before
touching the aging, because R-206 inherits its date mapping.

## What R-205 left for R-206, concretely

**`rentPeriodDebts` already exists** (`packages/core/ledger/aging.ts`, exported
from `@rental/core/ledger`). It takes the projected ledger rows and a
timezone and returns one dated `DatedCharge` per rent period the subscription
billed — the per-period debt list D-11/D-40 were said not to leave behind. It
is derived from the unlinked `CHARGE` entries `invoice.finalized` projects,
dated `businessDate(occurredAt, propertyZone)` with **no snapping**, and D-223
writes down at length why snapping to `dueDateOnOrBefore` was rejected (a
payer `debitDay` that differs from the subscription anchor makes it name a due
date up to a month OLDER than the invoice). Unit tests are in
`packages/core/ledger/aging.test.ts`.

**R-206 is the `delinquencyFor` half, and R-205 deliberately did not touch
it.** `oldestUnsettled` (`aging.ts:221-238`) still builds its debt list as the
charges plus *one* month's rent at `nearestRentDueOn`, and falls back to
`newestFirst[last].dueOn` when the balance outruns it — which is exactly what
a second unpaid month is. Replace that single synthetic debt with
`rentPeriodDebts`. **Its blast radius is why it is its own item**: the rent
roll (`apps/web/lib/payments/rent-roll.ts:231,426`), the dashboard delinquency
tile, `reports/queries.ts`, `chaseRungDue`'s exact-match ladder and the cure
notice's demand all read it, so every caller has to hand it the ledger rows
and the property zone.

**Three consequences the row names and a test should pin:** the rent roll
prints the oldest unpaid date somebody reads out in a hearing; the report
sorts by `daysLate`, so a mis-anchored row pins above genuinely older arrears;
and `chaseRungDue` matches `[1, 5, 15]` **exactly**, so at 309 days R-179's
whole ladder fires zero times. The opposite case is equally wrong — a lease
with no charge history reports two unpaid months as 19 days late, emptying the
`30+` bucket on a portfolio full of 60-day arrears.

**What R-205 changed under it, so R-206 is not surprised:** `assessLateFees`
pass 2 no longer calls `delinquencyFor` at all — it allocates the balance
itself over the charges plus `rentPeriodDebts` and assesses per period. So
R-206 is free to change `delinquencyFor`'s inputs without touching the
late-fee sweep, and the two readers should end up allocating the same list.

**R-207 is the cheapest real win in the arc** if you want a short session
instead: one line, `EMERGENCY_CATEGORIES` at
`packages/core/notifications/categories.ts:302-307`, and `priority:
'EMERGENCY'` is already sitting unread in the notify context at
`apps/web/lib/workorders/actions.ts:407-422`.

## Rules that bind this arc specifically

- **Re-verify every finding against the code before touching anything.**
  Only findings 1, 2 and 3 were spot-checked during planning; twelve are
  inherited evidence. Same discipline R-153 applied to the first review.
  R-205 re-verified finding 1 line by line and it was correct as written.
  Its worked numbers use an illustrative 5% rule; the rule actually seeded is
  10% capped at 12% of a month's rent, so the measured defect was **$180 —
  the cap — for two unpaid months where the fix charges 10% of each**.
- **Never backfill.** R-205's never-assessed fees, R-206's mis-anchored
  aging, R-209's un-credited deposits: report them, fix the writer, leave
  reconciled history alone. D-201 already paid for this lesson.
- **Four rows are Needs counsel** (R-205, R-208, R-213, R-217) and each has
  a product half that is wrong on its own terms — none is blocked on an
  answer to start.
- **D-222's "do not build" list is binding**, four reviews deep: no Stripe
  Connect, no house-rules settings screen, no second queue (D-9), no deposit
  interest engine, no `businessDaysBetween` rewrite, and **no move-in
  inspection that BLOCKS occupancy** — R-208 wants the report created and
  its absence visible, D-187's warn-never-block posture.

## What the review structurally could not see

**Anything only a browser shows.** It read code and schema. R-204's eight
defects were invisible to the test suite and one was invisible to every
screen. **R-220 is the Arc 5 demo walk and it owes the five public token
surfaces R-204 left unwalked** — bid, apply, prescreen, showing, pay;
`db:seed:demo-access` prints only the vendor job link.

**Anything gated on a real vendor API.** Screening, e-sign and credit
reporting run against simulated adapters (PRD 00 §14, D-7/D-27), so every
claim about them is a claim about the simulator. R-093 and R-097b stay
vendor-gated and are not laptop items — row 97 is deliberately still open
for that reason, while 81 and 155 were ticked ✅ this session.

## Still outstanding from R-187, owned by nobody

**The Neon dev branch is ten-plus migrations behind**, back to
`20260904120100_r165_guarantor_actor_type`, so it has no `PaymentPlan` table
at all. `npm run dev` reads `.env.local`, so a walk against the dev branch
would 500 on anything built since R-165. **`npm run db:migrate:dev` is the
whole fix; it has still not been run.** It writes to a cloud database, which
is why no session has done it unasked.

Also from R-187: the start-day boundary double-counts a charge raised on the
plan's own start date; no e2e walks the wrongly-completed warning.

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a
change touches a form control or page layout (D-194), and whenever a page
renders a user-supplied VALUE (D-197). **Locally `npm run test:e2e` runs BOTH
projects already** — so `--list` is how you get the real expected number.

**Use `npm test -- <path>` and `npm run test:e2e`, never bare `npx vitest` or
`npx playwright test`.** Both give a wall of instant failures with no
`DATABASE_URL`, which reads exactly like the jetsam symptom and is not it.
(`--list` is safe without it.)

**Prove a new assertion against the reverted fix** (D-197). R-202, R-203 and
R-204 all did.

**Read the e2e summary, not the tail of it.** The gate is
`passed + skipped + flaky` reconciling against `npx playwright test --list`.

**`npm run db:ci` before pushing a migration.** R-205 does not need a schema
change; R-217 (`habitabilityRepairDays` on `JurisdictionRule`) does.

**Check CI on the run, never copy a line forward.** `gh run list --commit`
only matches a FULL sha and returns EMPTY for a short one, with no error —
indistinguishable from "docs-only push, no run". `git rev-parse <short>`
first, or watch by id. That copy-forward error cost eleven items
(R-130–R-140).

## MACHINE CONTENTION — read this before diagnosing a red unit run

R-204's `npm test` was **3,173 passed in 14.9s**, so the machine was clean.
If a run comes back at 190s+ with `Hook timed out in 10000ms` in files the
item never touched, that is contention, not a regression:

1. `psql -c "select count(*) from pg_stat_activity"` → a project holding 30+ is the tell.
2. `ls -lt /Library/Logs/DiagnosticReports/JetsamEvent-*.ips` → no file for the
   relevant minute means the OS killed nothing. `Killed: 9` names no culprit.
3. `sysctl -n kern.memorystatus_level` / `vm.memory_pressure`.
4. `lsof -ti :3100`.
5. **The per-file duration table.** A file taking ~188s and still PASSING is
   this symptom's tell.

**Sibling daemons are not this repo's to kill** — scope every kill to `$PWD`.

## Leftovers still owned by nobody

From R-205: pass 2 now reads every active lease in the property, so
`leasesChecked` on the job record counts more than it did and a held lease can
be counted in `heldLeases` by both passes; a `LATE_FEE` charge raised by pass
1 earlier in the same run is in pass 2's debt list before it is in the
balance, understating that night's percentage fee by up to its own size
(the safe direction, and the same thing `delinquencyFor` does today).

Several of these are now promoted into Arc 5 rows and are marked so. The rest
stand.

From R-204: the seed's type vocabulary is guarded by nothing
(`ComplianceItem.type` is free-form by design, and R-195 recorded the same
shape for Task subject strings — both still true; the walk is the check);
demo rows already written keep their old raw dates until a `--reset`;
`esign-panel.tsx` declares `sentAt`, `completedAt`, `voidedAt` and renders
none of them.

From R-203: no staff withdraw for a signing request; the demo seed creates no
payment plan, so a walk can see neither R-199's schedule nor R-203's
signature; `LeaseSignerStatus.DECLINED` is written by nothing; nothing tells
staff a sent agreement has gone unsigned (deliberate, D-220).

From R-201: the deposit-slip PDF title and the §3955 SCRA notice are held by
no test; the demo seed creates no deposit batch and records no SCRA
termination. `consent-panel.tsx:172` is a **KNOWN FALSE POSITIVE — do not
"fix" it**; `friendlyBusinessDate` throws on `friendlyTimestamp` output.

From R-200: non-renewal notices already served carry the wrong end date in
stored `bodyText`; no e2e drives a business-day state through either notice
form; `observedHolidays` is seeded for no state; the demo seed configures
Texas only.

From R-199: a cancelled or broken plan sends the tenant nothing; the staff
lease page does not show where the schedule went; the guarantor portal does
not show the plan.

From R-198: a payment on a property deactivated mid-range is outside the
settlement report; a late-delivered payment in an already-swept range belongs
to no recorded transfer.

From R-196: `sendReminders` reports "sent to N people" even when every channel
was suppressed — **now R-211**; a phone-only guarantor cannot enter their
portal — **now R-216**.

From R-195: only `Lease` and `Deposit` Task routes are exercised end to end;
`demo-seed.mts` writes Task subject strings outside the union.

From R-194: the demo seed's Riverside notice has no demand; nothing drafts a
cure notice from the lease page or the final chase rung.

From R-193: no edit or delete on a property expense; the demo seed records
none, so every house reads "No property tax or insurance booked".

From R-183: no accrual engine, no interest rate on `JurisdictionRule`;
`Deposit.escrowAccountRef` / `interestAccruedCents` are written by nothing.
**D-222 keeps this out of scope** until a property in such a state exists.

From R-173: a tenant with a phone but no email still gets a live PORTAL row
and cannot sign in — **now R-216, and R-210 is the `Notice` half**.

From R-171: `writePayment` dedups only on `stripePaymentIntentId`, so an ACH
payment may write both a `PENDING` and a `SETTLED` row. Recorded as
**unknown** — verify against real Stripe.

From R-170a: `/staff/new` and `/staff/[id]` each take ~21s to axe-scan against
`/staff`'s 2.2s.
