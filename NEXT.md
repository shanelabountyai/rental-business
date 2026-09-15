# Next session

## R-209 is done. Pick up R-210 — the `Notice` that records service the product never proved.

R-209 shipped as `fa10c30` (SHA recorded in `6482fb9`). **CI: read it on the
run itself — `gh run list --limit 5` and look at the titles.** Do not copy a
CI line forward; that error cost eleven items (R-130–R-140). Both commits went
up in one push, so the run is attributed to the HEAD sha (`6482fb9`, the
docs-only one) and `gh run list --commit fa10c30` returns EMPTY with the
pipeline perfectly fine. Three separate ways to read a green pipeline as dead:
that attribution, `--commit` matching only a FULL sha (R-207), and
`paths-ignore: ['**.md', 'docs/**']` meaning a docs-only PUSH legitimately has
no run at all (R-207).

**Start here:** `docs/prds/06-backlog.md` → row 197 / **R-210**. The review is
verbatim at `docs/reviews/2026-09-13-operator-review.md`; D-222 holds the
binding "do not build" list.

**Re-verify the finding before touching anything.** R-205 through R-209 all
re-verified an inherited finding and all five were correct as written — R-209's
line numbers matched exactly, as R-208's had. That is five for five, which is a
reason to keep checking, not to stop.

## What R-209 established that R-210 and everything after it inherits

**`LedgerEntry` has exactly ONE production writer and it is the Stripe
webhook.** `grep -rn "ledgerEntry.create"` over non-test code returns
`apps/web/lib/billing/webhook.ts` and nothing else. If an item ever needs the
balance to move, it needs a Stripe event, not an insert. R-209's answer was an
**out-of-band payment** — a `Payment` row, then `recordOutOfBandPayment`
against the open invoice, with the entry arriving on the event
(`recordOfflinePayment` in `lib/payments/offline.ts` is the worked example,
and D-177's ordering — our row FIRST — is copied with it, or the event mints
a second row and every counter total doubles).

**Two shorter mechanisms look right and cannot work, both checked:**
- A Stripe **customer-balance credit** never projects at all. `invoice.finalized`
  reads `amount_due`, and its own comment says a balance credit is deliberately
  outside it.
- A **negative invoice item** (`waiveCharge`'s shape, and the one the review
  itself named) only lands on a FUTURE invoice. A tenancy at disposition has
  none, so the item sits pending for ever and the balance never moves.

Full reasoning: **D-227**.

## What R-209 left behind

- **Arrears spread across more than one open Stripe invoice are REFUSED, not
  part-paid.** `recordOutOfBandPayment` attaches to one invoice. Paying part
  would restore the letter-vs-ledger disagreement by a smaller number, so the
  finalize refuses with a message naming the amount. **Against the simulator
  the cap can never bite** (`getOpenInvoice` reports the whole lease balance as
  one synthetic invoice), so it is a real-Stripe-only path, stated rather than
  tested. The fix when it bites is a `getOpenInvoices` on the adapter plus a
  loop. Owned by nobody.
- **A push that lands while the local transaction then throws leaves a second
  unclaimed `Payment` row.** The money cannot move twice — the key is the
  deposit, Stripe refuses a second attach — but the debris is real. Closing it
  needs a column on `Payment` naming the deposit.
- **The finalized deposit screen no longer shows the outstanding balance it
  applied**, because that half of the totals is recomputed from the live
  ledger, which is now zero. Correct as of now, lossy as history; the letter
  holds the record. Owned by nobody.
- **`additionalOwedCents` is disclosed and never collected** — R-071's
  deliberate gap, not widened.

## A REAL DEFECT nobody owns, found while diagnosing a test failure

**`Notification.eventId` references `OutboxEvent` `ON DELETE SET NULL` and has
NO INDEX, against 503,225 `Notification` rows in `rental_test`.** Every
`outboxEvent.deleteMany` in a test teardown therefore seq-scans half a million
rows per deleted event. That is why `sms-intake.test.ts`,
`triage-consumer.test.ts` and `job-consumer.test.ts` — the three whose
`afterAll` does exactly that — are the first to tip over under any contention
at all, as `Hook timed out in 10000ms`. It is the slow face of the same
`SetNull`-onto-append-only hazard R-208 met in its throwing form. **An index on
`Notification.eventId` is a one-line migration** and R-209 did not take it,
because R-209 had no other reason to touch the schema. Anything that already
needs a migration should pick it up.

## MACHINE CONTENTION — R-209 hit it too, and the diagnosis inverted again

Two consecutive `npm test` runs came back **3 files failed / 3,204 tests
passed**, all three files unreachable from the diff, all three the hook timeout
above. Reproducible twice, which is not the usual flake signature. What settled
it, in order:

1. **`ls -lt /Library/Logs/DiagnosticReports/JetsamEvent-*.ips` → match the
   MINUTE.** Newest was 13:43 (R-208's); the runs died at 14:15 and 14:17. **No
   file for the relevant minutes, so the OS killed nothing** — the opposite
   reading from R-208, where the files' PRESENCE was the tell. Check
   timestamps, never just existence.
2. `sysctl -n kern.memorystatus_level` 76%, `vm.memory_pressure` 0.
3. `psql -d postgres -c "select datname, count(*) from pg_stat_activity group by datname"` → **`countertop_test` holding 11, then 19**.
4. `lsof -ti :3100` → empty.
5. **The decisive one: a run of HEAD with the change stashed.** Green in 37s.
   A re-run WITH the change: green in 33s, 3,204 passed. Sibling project, not
   this diff.

**Sibling sweeps are not this repo's to kill** — scope every kill to `$PWD`.

## Traps R-209 paid for

**A wrong ASSERTION looks exactly like a wrong product until you read the
database.** The negative spec asserted the "Refund payment" heading after
finalizing, on the correct-sounding reasoning that a disposition owing a refund
keeps its own screen. It does — on a later GET. `finalizeDisposition` ends in
`redirect(/notices/<id>)` unconditionally. The `Deposit` row said the
arithmetic was right (300000 / 90000 / 210000) while the browser said the page
was wrong; that combination is the signature. Query the row before editing the
product.

**`getByText` is a case-insensitive SUBSTRING match, and an `sr-only` button
label is the collision you will not predict.**
`getByText('Replace the kitchen worktop')` matched the deduction label AND the
remove button's `sr-only` " the <description> deduction". `exact: true` — the
more specific locator, never a relaxed assertion.

**A background wrapper masked the exit code exactly as CLAUDE.md warns.** The
harness reported "exit code 0" for a run whose log said `EXIT=1`. The
`cmd > log 2>&1; rc=$?; echo "EXIT=$rc" >> log` idiom is what caught it. Keep
using it.

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a change
touches a form control or page layout (D-194), and whenever a page renders a
user-supplied VALUE (D-197). Locally `npm run test:e2e` runs BOTH already, so
`--list` is how you get the real expected number — **1,240 tests in 100 files**
as of R-208; `e2e/deposits.spec.ts` alone is 12.

**Use `npm test -- <path>` and `npm run test:e2e`, never bare `npx vitest` or
`npx playwright test`** (`--list` is safe without it). In **zsh an unquoted
`$F` does not word-split** — spell the paths out.

**Prove a new assertion against the reverted fix** (D-197). R-202 through R-209
all did; R-209's revert took the positive spec red in both projects and left
the negative one green, which is what a spec asserting absence must do.

**Read the e2e summary, not the tail of it.** The gate is
`passed + skipped + flaky` reconciling against `npx playwright test --list`.

**`npm run db:ci` before pushing a migration.** R-209 needed none.
**R-217 (`habitabilityRepairDays` on `JurisdictionRule`) does need it**, and so
does anything that picks up the `Notification.eventId` index above.

**A `'use server'` module may export only async functions, including a type
re-export.** `npm run build` is the only check that catches it, and R-209 ran
it because it touched one.

## Rules that bind this arc specifically

- **Re-verify every finding against the code before touching anything.** Five
  for five correct so far.
- **Never backfill.** D-201/D-222 already paid for this lesson; R-209 obeyed it
  — deposits already disposed of keep their wrong balances and are reported,
  not rewritten.
- **Two rows still Needs counsel** (R-213, R-217).
- **D-222's "do not build" list is binding**: no Stripe Connect, no house-rules
  settings screen, no second queue (D-9), no deposit interest engine, no
  `businessDaysBetween` rewrite.

## What the review structurally could not see

**Anything only a browser shows.** It read code and schema. **R-220 is the
Arc 5 demo walk** and it owes the five public token surfaces R-204 left
unwalked — bid, apply, prescreen, showing, pay; `db:seed:demo-access` prints
only the vendor job link. It also owes R-208's new `Move-in condition walk`
checklist screen, and now the deposit disposition screen after R-209 — the
demo seed disposes of no deposit, so nothing in the demo exercises the new
payment path.

**Anything gated on a real vendor API.** Screening, e-sign and credit reporting
run against simulated adapters (PRD 00 §14, D-7/D-27). R-093 and R-097b stay
vendor-gated.

## Still outstanding from R-208, owned by nobody

- **A renewal successor still has no `MOVE_IN` report under its own
  `leaseId`.** The fix is for `move-out-copy.ts` to walk `renewedFromLeaseId`,
  NOT for activation to manufacture a second baseline. **R-218's
  deposit-dispute packet is the item that will feel it first.**
- **`defaultForType` is globally UNIQUE**, so the portfolio has exactly one
  move-in checklist. A per-property default is the next step and is not built.
- **The access-code warning cannot fire for a lease with no cash deposit** —
  `deposit-clearing-job.ts` selects `depositArrangement: 'CASH', depositCents:
  { gt: 0 }`.
- **The demo seed writes its leases straight to ACTIVE and emits no
  `lease.activated`**, so nothing in the demo exercises R-208's consumer.

## Still outstanding from R-187, owned by nobody

**The Neon dev branch is ten-plus migrations behind**, back to
`20260904120100_r165_guarantor_actor_type`, so it has no `PaymentPlan` table.
`npm run dev` reads `.env.local`, so a walk against it would 500 on anything
built since R-165. **`npm run db:migrate:dev` is the whole fix; it has still
not been run.** It writes to a cloud database, which is why no session has done
it unasked.

Also from R-187: the start-day boundary double-counts a charge raised on the
plan's own start date; no e2e walks the wrongly-completed warning.

## Leftovers still owned by nobody

From R-207: `urgent` does not reach `scheduleRetry`, so a bounced emergency is
still retried at 08:00 (needs a `Notification` column plus a migration — pair
it with the `eventId` index above); `plan-actions.ts:258` counts a DEFERRED
outcome as "on its way" (R-211 owns the neighbouring `sendReminders` version);
the bid-request send in `approvals.ts` sets no `urgent` and still defers,
deliberately; no e2e drives `dispatchToVendor`'s notice.

From R-206: the chase ladder fires once per arrears EPISODE, not once per
unpaid period, recorded as D-224; `webhook.ts:296` can put fee money in an
unlinked `CHARGE` entry when `fits = linkedTotal <= movedCents` is false
(understating, the safe half); a balance moved by an `ADJUSTMENT` with no
charge behind it still falls through to the oldest known debt (deliberate);
`late-fees.ts` pass 2 deliberately does not use `rentDebtsFor`.

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

From R-199: a cancelled or broken plan sends the tenant nothing; the staff
lease page does not show where the schedule went.

From R-198: a payment on a property deactivated mid-range is outside the
settlement report.

From R-196: `sendReminders` reports "sent to N people" even when every channel
was suppressed — **now R-211**; a phone-only guarantor cannot enter their
portal — **now R-216**.

From R-195: only `Lease` and `Deposit` Task routes are exercised end to end.

From R-194: the demo seed's Riverside notice has no demand; nothing drafts a
cure notice from the lease page or the final chase rung.

From R-193: no edit or delete on a property expense; the demo seed records
none.

From R-183: no accrual engine, no interest rate on `JurisdictionRule`.
**D-222 keeps this out of scope.**

From R-173: a tenant with a phone but no email still gets a live PORTAL row and
cannot sign in — **now R-216, and R-210 is the `Notice` half**.

From R-171: `writePayment` dedups only on `stripePaymentIntentId`, so an ACH
payment may write both a `PENDING` and a `SETTLED` row. Recorded as
**unknown** — verify against real Stripe.

From R-170a: `/staff/new` and `/staff/[id]` each take ~21s to axe-scan against
`/staff`'s 2.2s.
