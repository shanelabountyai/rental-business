# Next session

## R-211 is done. Pick up R-212 — the retaliation guard is off the renewal path.

R-211 shipped as `11f9d16` (SHA recorded in the follow-up commit). **CI: read it
on the run itself — `gh run list --limit 5` and look at the titles.** Do not
copy a CI line forward; that error cost eleven items (R-130–R-140). R-211's own
run is `35107573413` on *"R-211: record the SHA"*; its neighbour `35107572503`
was **cancelled in 2s by the second push**, which is Vercel-style auto job
cancellation and is not a failure. Three separate ways to read a green pipeline
as dead, all still true: both commits go up in one push so the run is attributed
to the HEAD (docs-only) sha and `--commit <work sha>` returns EMPTY; `--commit`
matches only a FULL sha (R-207); and `paths-ignore: ['**.md', 'docs/**']` means
a docs-only PUSH legitimately has no run at all (R-207).

**Start here:** `docs/prds/06-backlog.md` → row 199 / **R-212**. The review is
verbatim at `docs/reviews/2026-09-13-operator-review.md` §8; D-222 holds the
binding "do not build" list.

**Re-verify the finding before touching anything.** R-205 through R-211 all
re-verified an inherited finding and all seven were correct as written. R-211's
was correct *and under-reported*: the row named `workorders/scheduling.ts:315`
and `inspections/scheduling.ts:299` carried the byte-identical sentence from
the byte-identical `try`/`catch`. Seven for seven, with one of them larger than
advertised, is a reason to keep checking and to grep for siblings.

## What R-211 established that R-212 can use

**`reachOf(outcomes)` in `apps/web/lib/notifications/reach.ts` is now the one
place that decides what a send actually did** — `SENT | ALREADY_SENT |
DEFERRED | NOT_SENT`, with a plain-English `why` and the earliest `sendAfter`.
Five callers read it. **Thirty-four still do not, and that is scope, not an
oversight**: the five fixed are the ones that make a claim to a person on a
screen. If R-212 touches a caller that says something was sent, reading the
outcome is now a two-line change — do it rather than leaving a sixth copy of
the old optimism.

**The next three of the same shape, each two lines:**
`applications/actions.ts:239` (*"has been sent their own link"*),
`party-change-builder.ts:516` (*"Amendment sent to everybody for signature"*),
`workorders/actions.ts:505` (*"the tenant has been asked to confirm"*). The
showing paths were checked and make no claim — the prospect is the actor and
the copy is *"Booked."*

**D-229 settled four calls; do not re-open them.** `digest_batched` counts as
SENT. PORTAL is excluded before anything else is read. DEFERRED is *scheduled*,
not sent — against the backlog row's own prescription, because R-207 had
already recorded that as a gap. A duplicate is `ALREADY_SENT`, not "not sent".

## What R-211 left behind

- **An unserved entry notice still PERMITS the entry it was generated for.**
  R-210's leftover, untouched — now visible on the screen rather than only in
  the table, because the notice names it. Closing it means deciding whether
  scheduling refuses, warns or proceeds. A product question. Owned by nobody.
- **The two entry-notice sites have no unserved-case e2e of their own.** The
  regression check lives on `rent-roll.spec.ts` — the one of the five whose
  fixture can already build a party nobody can reach — plus eleven unit
  assertions on `reachOf`/`entryNoticeClause`. Both scheduling sites take the
  identical clause from the identical helper.
- **Nothing is backfilled** (D-201/D-222). `message.bulk_sent` rows already
  written with an inflated `sentToPeople` keep it.

## A trap R-211 paid for, and it still applies

**EVERY FIXTURE PARTY IN THIS SUITE HAS AN EMAIL ADDRESS.** The defect survived
because the product only ever ran the branch where its optimism happened to be
right. `rent-roll.spec.ts`'s new `includeUnreachableGuarantor` option is the
shape: `email: null, phone: null`, its own option rather than a change to
`includeExtraParties`, whose three-person count is another test's assertion. A
STOP or a missing consent is NOT enough — those leave email live. Same class as
D-132's `from: 'tenant@example.test'`.

## REAL DEFECTS nobody owns

**`Notification.eventId` references `OutboxEvent` `ON DELETE SET NULL` and has
NO INDEX, against 500k+ `Notification` rows in `rental_test`.** Every
`outboxEvent.deleteMany` in a teardown seq-scans half a million rows per deleted
event, which is why `sms-intake.test.ts`, `triage-consumer.test.ts` and
`job-consumer.test.ts` tip over first under contention as `Hook timed out in
10000ms`. **A one-line migration.** R-209, R-210 and R-211 all had no other
reason to touch the schema; anything that already needs a migration should pick
it up. Pair it with R-207's `urgent`-on-`scheduleRetry` column.

**The Neon dev branch is ten-plus migrations behind** (R-187), back to
`20260904120100_r165_guarantor_actor_type`, so it has no `PaymentPlan` table.
`npm run dev` reads `.env.local`, so a walk against it 500s on anything built
since R-165. **`npm run db:migrate:dev` is the whole fix; it has still not been
run.** It writes to a cloud database, which is why no session has done it
unasked.

## Standing traps worth re-reading

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a change
touches a form control or page layout (D-194), and whenever a page renders a
user-supplied VALUE (D-197). Locally `npm run test:e2e` runs BOTH already, so
`--list` is how you get the real expected number.

**Use `npm test -- <path>` and `npm run test:e2e`, never bare `npx vitest` or
`npx playwright test`** (`--list` is safe without it). In **zsh an unquoted `$F`
does not word-split** — spell the paths out.

**Prove a new assertion against the reverted fix** (D-197). R-202 through R-211
all did. R-211 stubbed its two branches to `if (false as boolean)` — typecheck
stays clean, the fix is genuinely inert, and exactly the one new spec went red
in both projects with the other 18 in the file green.

**Read the e2e summary, not the tail of it.** The gate is `passed + skipped +
flaky` reconciling against `npx playwright test --list`.

**Never let a wrapper mask the exit code.** `cmd > log 2>&1; rc=$?; echo
"EXIT=$rc" >> log; exit $rc`. R-209's harness reported exit 0 over a log saying
`EXIT=1`.

**`npm run db:ci` before pushing a migration.** R-211 needed none. **R-217
(`habitabilityRepairDays` on `JurisdictionRule`) does need it**, and so does
anything that picks up the `Notification.eventId` index.

**A `'use server'` module may export only async functions, including a type
re-export.** This is why `reach.ts` and `dispatch-notice.ts` are their own
modules rather than helpers inside the action files that use them.

**Sibling sweeps are not this repo's to kill** — scope every kill to `$PWD`.
`ls -lt /Library/Logs/DiagnosticReports/JetsamEvent-*.ips` and **match the
MINUTE**, never just existence.

## Rules that bind this arc specifically

- **Re-verify every finding against the code before touching anything.** Seven
  for seven correct so far, one of them larger than the row said.
- **Never backfill.** D-201/D-222 already paid for this lesson.
- **Two rows still Needs counsel** (R-213, R-217).
- **D-222's "do not build" list is binding**: no Stripe Connect, no house-rules
  settings screen, no second queue (D-9), no deposit interest engine, no
  `businessDaysBetween` rewrite.

## What the review structurally could not see

**Anything only a browser shows.** It read code and schema. **R-220 is the Arc 5
demo walk** and it owes the five public token surfaces R-204 left unwalked — bid,
apply, prescreen, showing, pay; `db:seed:demo-access` prints only the vendor job
link. It also owes R-208's `Move-in condition walk` screen, R-209's deposit
disposition screen, **R-210's unserved-notice state**, and now **R-211's
not-sent copy**: the demo seed gives every party an email, so nothing in the
demo shows the rent chase naming a person it could not reach.

**Anything gated on a real vendor API.** Screening, e-sign and credit reporting
run against simulated adapters (PRD 00 §14, D-7/D-27). R-093 and R-097b stay
vendor-gated.

## Still outstanding from R-209

- **Arrears spread across more than one open Stripe invoice are REFUSED, not
  part-paid.** Real-Stripe-only path. Fix is a `getOpenInvoices` on the adapter
  plus a loop.
- **A push that lands while the local transaction then throws leaves a second
  unclaimed `Payment` row.** Needs a column on `Payment` naming the deposit.
- **The finalized deposit screen no longer shows the outstanding balance it
  applied** — recomputed from a ledger that is now zero. The letter holds the
  record.
- **`additionalOwedCents` is disclosed and never collected** — R-071's gap.

## Still outstanding from R-208

- **A renewal successor still has no `MOVE_IN` report under its own `leaseId`.**
  The fix is for `move-out-copy.ts` to walk `renewedFromLeaseId`. **R-218's
  deposit-dispute packet feels it first.**
- **`defaultForType` is globally UNIQUE**, so the portfolio has exactly one
  move-in checklist.
- **The access-code warning cannot fire for a lease with no cash deposit.**
- **The demo seed writes leases straight to ACTIVE and emits no
  `lease.activated`.**

## Leftovers still owned by nobody

From R-187: the start-day boundary double-counts a charge raised on the plan's
own start date; no e2e walks the wrongly-completed warning.

From R-207: `urgent` does not reach `scheduleRetry`, so a bounced emergency is
still retried at 08:00 (needs a `Notification` column plus a migration); the
bid-request send in `approvals.ts` sets no `urgent` and still defers,
deliberately; no e2e drives `dispatchToVendor`'s notice. **The
`plan-actions.ts:258` half is closed by R-211/D-229.**

From R-206: the chase ladder fires once per arrears EPISODE, not once per unpaid
period (D-224); `webhook.ts:296` can put fee money in an unlinked `CHARGE` entry
when `fits` is false (understating, the safe half); a balance moved by an
`ADJUSTMENT` with no charge behind it falls through to the oldest known debt
(deliberate); `late-fees.ts` pass 2 deliberately does not use `rentDebtsFor`.

From R-205: pass 2 reads every active lease in the property, so `leasesChecked`
counts more than it did and a held lease can be counted in `heldLeases` by both
passes; a `LATE_FEE` raised by pass 1 earlier in the same run is in pass 2's
debt list before it is in the balance.

From R-204: the seed's type vocabulary is guarded by nothing; demo rows keep
their old raw dates until a `--reset`; `esign-panel.tsx` declares `sentAt`,
`completedAt`, `voidedAt` and renders none.

From R-203: no staff withdraw for a signing request; the demo seed creates no
payment plan; `LeaseSignerStatus.DECLINED` is written by nothing.

From R-201: the deposit-slip PDF title and the §3955 SCRA notice are held by no
test. `consent-panel.tsx:172` is a **KNOWN FALSE POSITIVE — do not "fix" it**;
`friendlyBusinessDate` throws on `friendlyTimestamp` output.

From R-200: non-renewal notices already served carry the wrong end date in
stored `bodyText`; no e2e drives a business-day state through either notice
form; `observedHolidays` is seeded for no state.

From R-199: a cancelled or broken plan sends the tenant nothing; the staff lease
page does not show where the schedule went.

From R-198: a payment on a property deactivated mid-range is outside the
settlement report.

From R-196: **"sent to N people" even when every channel was suppressed is
CLOSED by R-211**; a phone-only guarantor cannot enter their portal — **R-216**.

From R-195: only `Lease` and `Deposit` Task routes are exercised end to end.

From R-194: the demo seed's Riverside notice has no demand; nothing drafts a
cure notice from the lease page or the final chase rung.

From R-193: no edit or delete on a property expense; the demo seed records none.

From R-183: no accrual engine, no interest rate on `JurisdictionRule`. **D-222
keeps this out of scope.**

From R-173: a tenant with a phone but no email still gets a live PORTAL row and
cannot sign in — **now R-216; R-210 fixed the `Notice` half and R-211 made
`reachOf` refuse to count the portal row as reach**.

From R-171: `writePayment` dedups only on `stripePaymentIntentId`, so an ACH
payment may write both a `PENDING` and a `SETTLED` row. Recorded as **unknown**
— verify against real Stripe.

From R-170a: `/staff/new` and `/staff/[id]` each take ~21s to axe-scan against
`/staff`'s 2.2s.
