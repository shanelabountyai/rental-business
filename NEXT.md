# Next session

## R-210 is done. Pick up R-211 — the suppressed notification reported as sent.

R-210 shipped as `623a4a0` (SHA recorded in `037828a`). **CI: read it on the
run itself — `gh run list --limit 5` and look at the titles.** Do not copy a
CI line forward; that error cost eleven items (R-130–R-140). R-210's own run
`35015278369` went **green on both jobs** — verify and e2e/axe/Lighthouse.
R-209's run `35013699775` was **cancelled by R-210's push** after its verify
job passed, so its e2e job never finished; R-210's run covers both commits.
That auto-cancel is the same mechanism the `ignoreCommand` rule turns on, and
it is why a cancelled neighbouring run is not a failure. Three separate ways to read a green pipeline as dead: both commits go
up in one push so the run is attributed to the HEAD (docs-only) sha and
`--commit <work sha>` returns EMPTY; `--commit` matches only a FULL sha
(R-207); and `paths-ignore: ['**.md', 'docs/**']` means a docs-only PUSH
legitimately has no run at all (R-207).

**Start here:** `docs/prds/06-backlog.md` → row 198 / **R-211**. The review is
verbatim at `docs/reviews/2026-09-13-operator-review.md` §7; D-222 holds the
binding "do not build" list.

**Re-verify the finding before touching anything.** R-205 through R-210 all
re-verified an inherited finding and all six were correct as written —
R-210's five call sites matched exactly, line numbers included. That is six
for six, which is a reason to keep checking, not to stop.

## What R-210 established that R-211 inherits directly

**R-211 IS THE OTHER HALF OF THE SAME SENTENCE.** R-210 fixed what the
`Notice` table *records*; R-211 fixes what the operator is *told*. The two
meet on `workorders/scheduling.ts:315` — *"Scheduled, and the tenant has been
told"* — which R-210 deliberately did not touch, because the fix belongs at
the shared helper and not at that call site. Read D-228 before starting.

**`notify()`'s outcome is already the honest record and three callers read
it.** `ChannelOutcome` carries `channel`, `status` (`QUEUED | SUPPRESSED |
DEFERRED`), `reason` and `deliveryId`. R-210's FCRA fix is a fourth reader and
the worked example for reading it *after dispatch*: find the outcome for the
channel you care about, then read `notificationDelivery.status === 'SENT'`,
because `dispatchPendingNotifications` sets SENT only once the adapter
returned one. `screening/staff-actions.ts` holds that pattern in about
fifteen lines.

**The backlog row's own prescription — count `QUEUED`/`DEFERRED` as sent —
is weaker than what R-210 needed and R-207 already recorded the gap:**
`plan-actions.ts:258` counting a DEFERRED outcome as "on its way" is an open
leftover. A DEFERRED entry notice is not sent; it is scheduled. Decide that
deliberately and write it down rather than inheriting the row's wording.

**`canReceiveAuthLink` in `apps/web/lib/auth/delivery.ts` is the new
predicate** and is deliberately EMAIL-only, not `reachableElectronically`'s
email-or-phone, because `deliverAuthLink` sends every sign-in link on
`account_access`. **R-216 is the one line that widens it.** Do not add a
second copy of the predicate anywhere.

## What R-210 left behind

- **An unserved entry notice still PERMITS the entry it was generated for.**
  `entryDecision` is untouched and `entryNoticeId` is still set either way, so
  a tenancy with no email can have a visit scheduled on a notice nobody has
  served. The record is now honest; the gate is not. Closing it means deciding
  whether scheduling refuses, warns, or proceeds — a product question. Owned
  by nobody.
- **A tenant with a phone and no email gets no `serve_notice_offline` task.**
  D-179's trigger is `smsBlocked || !reachableElectronically`, and that tenant
  is reachable, so the SMS goes and no task appears; the unserved notice is
  visible on `/notices` and nowhere else. **R-216 closes this properly.**
- **The other five sites have no unserved-case test of their own.** The check
  lives on `chargeback-actions.test.ts` — the one of the six whose harness can
  already build a tenant. The other five take the identical predicate three
  lines from the identical create.
- **Nothing is backfilled** (D-201/D-222). Notices already recorded as served
  to a portal the tenant cannot open keep their wrong columns.

## A trap R-210 paid for, and it aims straight at R-211

**EVERY FIXTURE TENANT IN THIS SUITE HAS AN EMAIL ADDRESS.** `e2e/screening.
spec.ts:268` asserts *"a decline generates and auto-serves an FCRA
adverse-action notice by email"* and passed identically before and after the
fix, because the whole product only ever ran the branch where the optimism
happened to be right. Same class as D-132's `from: 'tenant@example.test'` and
the four items it silently broke. **R-211's defect is reported to be invisible
for exactly this reason** — a suppressed outcome needs a recipient who is
actually suppressed, so build the fixture that has no consent, or a STOP, or
no address at all. `chargeback-actions.test.ts`'s `billableJob({ email:
false })` is the shape.

## REAL DEFECTS nobody owns

**`Notification.eventId` references `OutboxEvent` `ON DELETE SET NULL` and has
NO INDEX, against 503,225 `Notification` rows in `rental_test`.** Every
`outboxEvent.deleteMany` in a test teardown seq-scans half a million rows per
deleted event, which is why `sms-intake.test.ts`, `triage-consumer.test.ts`
and `job-consumer.test.ts` are first to tip over under contention, as `Hook
timed out in 10000ms`. **A one-line migration.** R-209 and R-210 both had no
other reason to touch the schema; anything that already needs a migration
should pick it up. Pair it with R-207's `urgent`-on-`scheduleRetry` column.

**The Neon dev branch is ten-plus migrations behind** (R-187), back to
`20260904120100_r165_guarantor_actor_type`, so it has no `PaymentPlan` table.
`npm run dev` reads `.env.local`, so a walk against it 500s on anything built
since R-165. **`npm run db:migrate:dev` is the whole fix; it has still not
been run.** It writes to a cloud database, which is why no session has done it
unasked.

## Standing traps worth re-reading

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a
change touches a form control or page layout (D-194), and whenever a page
renders a user-supplied VALUE (D-197). Locally `npm run test:e2e` runs BOTH
already, so `--list` is how you get the real expected number.

**Use `npm test -- <path>` and `npm run test:e2e`, never bare `npx vitest` or
`npx playwright test`** (`--list` is safe without it). In **zsh an unquoted
`$F` does not word-split** — spell the paths out.

**Prove a new assertion against the reverted fix** (D-197). R-202 through
R-210 all did. R-210 reverted each of its two halves separately and confirmed
each assertion goes red for its own reason and nothing else — worth copying
when an item fixes two things.

**Read the e2e summary, not the tail of it.** The gate is `passed + skipped +
flaky` reconciling against `npx playwright test --list`.

**Never let a wrapper mask the exit code.** `cmd > log 2>&1; rc=$?; echo
"EXIT=$rc" >> log; exit $rc`. R-209's harness reported exit 0 over a log
saying `EXIT=1`.

**`npm run db:ci` before pushing a migration.** R-210 needed none. **R-217
(`habitabilityRepairDays` on `JurisdictionRule`) does need it**, and so does
anything that picks up the `Notification.eventId` index.

**A `'use server'` module may export only async functions, including a type
re-export.** `npm run build` is the only check that catches it; R-210 ran it
because five of its six files are `'use server'`.

**Sibling sweeps are not this repo's to kill** — scope every kill to `$PWD`.
`ls -lt /Library/Logs/DiagnosticReports/JetsamEvent-*.ips` and **match the
MINUTE**, never just existence (R-209 read it the opposite way to R-208 and
both were right).

## Rules that bind this arc specifically

- **Re-verify every finding against the code before touching anything.** Six
  for six correct so far.
- **Never backfill.** D-201/D-222 already paid for this lesson.
- **Two rows still Needs counsel** (R-213, R-217).
- **D-222's "do not build" list is binding**: no Stripe Connect, no
  house-rules settings screen, no second queue (D-9), no deposit interest
  engine, no `businessDaysBetween` rewrite.

## What the review structurally could not see

**Anything only a browser shows.** It read code and schema. **R-220 is the
Arc 5 demo walk** and it owes the five public token surfaces R-204 left
unwalked — bid, apply, prescreen, showing, pay; `db:seed:demo-access` prints
only the vendor job link. It also owes R-208's `Move-in condition walk`
screen, R-209's deposit disposition screen, and now **R-210's unserved-notice
state**: the demo seed gives every tenant an email, so nothing in the demo
shows `/notices`'s "N not yet served" doing its job.

**Anything gated on a real vendor API.** Screening, e-sign and credit
reporting run against simulated adapters (PRD 00 §14, D-7/D-27). R-093 and
R-097b stay vendor-gated.

## Still outstanding from R-209

- **Arrears spread across more than one open Stripe invoice are REFUSED, not
  part-paid.** Real-Stripe-only path; against the simulator the cap cannot
  bite. Fix is a `getOpenInvoices` on the adapter plus a loop.
- **A push that lands while the local transaction then throws leaves a second
  unclaimed `Payment` row.** Needs a column on `Payment` naming the deposit.
- **The finalized deposit screen no longer shows the outstanding balance it
  applied** — recomputed from a ledger that is now zero. The letter holds the
  record.
- **`additionalOwedCents` is disclosed and never collected** — R-071's gap.

## Still outstanding from R-208

- **A renewal successor still has no `MOVE_IN` report under its own
  `leaseId`.** The fix is for `move-out-copy.ts` to walk `renewedFromLeaseId`.
  **R-218's deposit-dispute packet feels it first.**
- **`defaultForType` is globally UNIQUE**, so the portfolio has exactly one
  move-in checklist.
- **The access-code warning cannot fire for a lease with no cash deposit.**
- **The demo seed writes leases straight to ACTIVE and emits no
  `lease.activated`.**

## Leftovers still owned by nobody

From R-187: the start-day boundary double-counts a charge raised on the plan's
own start date; no e2e walks the wrongly-completed warning.

From R-207: `urgent` does not reach `scheduleRetry`, so a bounced emergency is
still retried at 08:00 (needs a `Notification` column plus a migration);
`plan-actions.ts:258` counts a DEFERRED outcome as "on its way" — **R-211 owns
the neighbouring `sendReminders` version and should settle both**; the
bid-request send in `approvals.ts` sets no `urgent` and still defers,
deliberately; no e2e drives `dispatchToVendor`'s notice.

From R-206: the chase ladder fires once per arrears EPISODE, not once per
unpaid period (D-224); `webhook.ts:296` can put fee money in an unlinked
`CHARGE` entry when `fits` is false (understating, the safe half); a balance
moved by an `ADJUSTMENT` with no charge behind it falls through to the oldest
known debt (deliberate); `late-fees.ts` pass 2 deliberately does not use
`rentDebtsFor`.

From R-205: pass 2 reads every active lease in the property, so `leasesChecked`
counts more than it did and a held lease can be counted in `heldLeases` by
both passes; a `LATE_FEE` raised by pass 1 earlier in the same run is in pass
2's debt list before it is in the balance.

From R-204: the seed's type vocabulary is guarded by nothing; demo rows keep
their old raw dates until a `--reset`; `esign-panel.tsx` declares `sentAt`,
`completedAt`, `voidedAt` and renders none.

From R-203: no staff withdraw for a signing request; the demo seed creates no
payment plan; `LeaseSignerStatus.DECLINED` is written by nothing.

From R-201: the deposit-slip PDF title and the §3955 SCRA notice are held by
no test. `consent-panel.tsx:172` is a **KNOWN FALSE POSITIVE — do not "fix"
it**; `friendlyBusinessDate` throws on `friendlyTimestamp` output.

From R-200: non-renewal notices already served carry the wrong end date in
stored `bodyText`; no e2e drives a business-day state through either notice
form; `observedHolidays` is seeded for no state.

From R-199: a cancelled or broken plan sends the tenant nothing; the staff
lease page does not show where the schedule went.

From R-198: a payment on a property deactivated mid-range is outside the
settlement report.

From R-196: `sendReminders` reports "sent to N people" even when every channel
was suppressed — **this is R-211, the item you are starting**; a phone-only
guarantor cannot enter their portal — **now R-216**.

From R-195: only `Lease` and `Deposit` Task routes are exercised end to end.

From R-194: the demo seed's Riverside notice has no demand; nothing drafts a
cure notice from the lease page or the final chase rung.

From R-193: no edit or delete on a property expense; the demo seed records
none.

From R-183: no accrual engine, no interest rate on `JurisdictionRule`.
**D-222 keeps this out of scope.**

From R-173: a tenant with a phone but no email still gets a live PORTAL row
and cannot sign in — **now R-216; R-210 fixed the `Notice` half**.

From R-171: `writePayment` dedups only on `stripePaymentIntentId`, so an ACH
payment may write both a `PENDING` and a `SETTLED` row. Recorded as
**unknown** — verify against real Stripe.

From R-170a: `/staff/new` and `/staff/[id]` each take ~21s to axe-scan against
`/staff`'s 2.2s.
