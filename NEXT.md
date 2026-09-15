# Next session

## R-206 is done. Pick up R-207 — one line, the cheapest real win in Arc 5.

R-206 shipped as `ef39547` (SHA recorded in `770ea18`). CI run
`34989417726` — read its verdict on the run itself, `gh run view 34989417726`;
`docs/PROGRESS.md`'s R-206 entry records what it said. **Do not copy a CI line
forward.** `gh run list --commit` matches only a FULL sha and returns empty for
a short one with no error, indistinguishable from "docs-only push, no run" —
`git rev-parse` first. That copy-forward error cost eleven items
(R-130–R-140).

**Start here:** `docs/prds/06-backlog.md` → row 194 / **R-207**. The review is
verbatim at `docs/reviews/2026-09-13-operator-review.md` §3; D-222 holds the
binding "do not build" list.

## R-207, concretely

`EMERGENCY_CATEGORIES` has exactly one member, `maintenance_emergency`
(`packages/core/notifications/categories.ts:302-307`). The vendor dispatch
sends on `work_order_assigned` with a `propertyId`
(`apps/web/lib/workorders/actions.ts:407-422`), so it gets `deferUntil =
quietHoursEndAfter(...)` and status `DEFERRED`
(`apps/web/lib/notifications/send.ts:180-193,307-309`), and the drain only
takes `sendAfter: { lte: now }` (`:605`). Default quiet hours are 21:00–08:00
(`packages/core/notifications/quiet-hours.ts:32`) — **eleven hours**. The
plumber assigned to a 22:40 sewage backup is texted at 08:00 and the screen
says the dispatch went. `priority: 'EMERGENCY'` is already sitting unread in
the notify context. `reissue.ts:105` has the same shape — grep before fixing
only the path the row names.

Two halves, and the row asks for both: bypass quiet hours for an EMERGENCY
work order (or for a VENDOR recipient at all — a business being dispatched,
not a consumer being marketed to), **and say on the screen when a send was
deferred**. The second half is what makes the first provable.

## What R-206 left behind

- **The chase ladder fires once per arrears EPISODE, not once per unpaid
  period.** `chaseRungDue` matches days past grace exactly against `[1, 5,
  15]` off one anchor per lease, so a second unpaid month recovers no rung.
  The row claimed the fix would restore the ladder; it does not, and D-224
  records that correction rather than dropping it. What the fix restores is
  the date, the `30+` bucket and the sort. Owned by nobody.
- **`webhook.ts:296` can put fee money in an unlinked `CHARGE` entry.**
  `fits = linkedTotal <= movedCents` writes NO linked rows when false, so a
  part-paid invoice becomes one unlinked remainder that `rentPeriodDebts`
  reads as rent while the `Charge` row is still in the list separately. The
  debit side is double-counted, so the anchor moves NEWER — understating, the
  safe half. Inherited from R-205.
- A balance moved by an `ADJUSTMENT` with no charge behind it still falls
  through to the oldest known debt. Deliberate and unchanged.
- `late-fees.ts` pass 2 deliberately does **not** use `rentDebtsFor`.

## The fixture rule paid off three times in two items — expect a fourth

R-205 fixed `rent-roll.spec.ts` (UTC midnight reads as the previous local
day). R-206's gate then went red in `evictions.spec.ts`, a file the item never
opened: its cure-notice fixture wrote the late fee as an **unlinked** `CHARGE`
ledger entry beside its own `Charge` row, and `chargeId: null` is the only
marker saying *this is the subscription's rent line*. Production cannot
produce that shape — `webhook.ts:296-337` writes one linked row per `Charge`
and exactly one unlinked remainder. **Before trusting any fixture that writes
a `LedgerEntry` by hand, check `chargeId` and check the hour.**

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a
change touches a form control or page layout (D-194), and whenever a page
renders a user-supplied VALUE (D-197). Locally `npm run test:e2e` runs BOTH
already, so `--list` is how you get the real expected number.

**Use `npm test -- <path>` and `npm run test:e2e`, never bare `npx vitest` or
`npx playwright test`** (`--list` is safe without it). And in **zsh an
unquoted `$F` does not word-split** — `npx playwright test --list $FILES` came
back `Total: 0 tests in 0 files` with exit 1 and no explanation. Spell the
paths out.

**Prove a new assertion against the reverted fix** (D-197). R-202 through
R-206 all did.

**Read the e2e summary, not the tail of it.** The gate is
`passed + skipped + flaky` reconciling against `npx playwright test --list`.

**`npm run db:ci` before pushing a migration.** R-207 needs no schema change;
R-217 (`habitabilityRepairDays` on `JurisdictionRule`) does.

## MACHINE CONTENTION — read this before diagnosing a red unit run

R-206's first `npm test` came back **5 files red on `Hook timed out in
10000ms`** in files the item never opened; the five passed in **1.6s** alone
and the clean re-run was **3,185 passed in 24.6s**. That is contention, not a
regression. The checks, in order:

1. `psql -d postgres -c "select datname, count(*) from pg_stat_activity group by datname"` → a project holding 30+ is the tell.
2. `ls -lt /Library/Logs/DiagnosticReports/JetsamEvent-*.ips` → no file for the relevant minute means the OS killed nothing. `Killed: 9` names no culprit.
3. `sysctl -n kern.memorystatus_level` / `vm.memory_pressure`.
4. `lsof -ti :3100`.
5. **The per-file duration table.** A file taking ~188s and still PASSING is this symptom's tell.

**Sibling daemons are not this repo's to kill** — scope every kill to `$PWD`.

## Rules that bind this arc specifically

- **Re-verify every finding against the code before touching anything.**
  Findings 1, 2 and 3 were spot-checked during planning; twelve are inherited
  evidence. R-205 and R-206 both re-verified and both were correct as written.
- **Never backfill.** Report the history, fix the writer, leave reconciled
  rows alone. D-201 already paid for this lesson.
- **Four rows are Needs counsel** (R-205, R-208, R-213, R-217); none is
  blocked on an answer to start.
- **D-222's "do not build" list is binding**: no Stripe Connect, no
  house-rules settings screen, no second queue (D-9), no deposit interest
  engine, no `businessDaysBetween` rewrite, and no move-in inspection that
  BLOCKS occupancy.

## What the review structurally could not see

**Anything only a browser shows.** It read code and schema. **R-220 is the
Arc 5 demo walk** and it owes the five public token surfaces R-204 left
unwalked — bid, apply, prescreen, showing, pay; `db:seed:demo-access` prints
only the vendor job link.

**Anything gated on a real vendor API.** Screening, e-sign and credit
reporting run against simulated adapters (PRD 00 §14, D-7/D-27). R-093 and
R-097b stay vendor-gated.

## Still outstanding from R-187, owned by nobody

**The Neon dev branch is ten-plus migrations behind**, back to
`20260904120100_r165_guarantor_actor_type`, so it has no `PaymentPlan` table.
`npm run dev` reads `.env.local`, so a walk against it would 500 on anything
built since R-165. **`npm run db:migrate:dev` is the whole fix; it has still
not been run.** It writes to a cloud database, which is why no session has
done it unasked.

Also from R-187: the start-day boundary double-counts a charge raised on the
plan's own start date; no e2e walks the wrongly-completed warning.

## Leftovers still owned by nobody

From R-205: pass 2 reads every active lease in the property, so
`leasesChecked` counts more than it did and a held lease can be counted in
`heldLeases` by both passes; a `LATE_FEE` raised by pass 1 earlier in the same
run is in pass 2's debt list before it is in the balance, understating that
night's percentage fee by up to its own size.

From R-204: the seed's type vocabulary is guarded by nothing; demo rows keep
their old raw dates until a `--reset`; `esign-panel.tsx` declares `sentAt`,
`completedAt`, `voidedAt` and renders none.

From R-203: no staff withdraw for a signing request; the demo seed creates no
payment plan, so a walk can see neither R-199's schedule nor R-203's
signature; `LeaseSignerStatus.DECLINED` is written by nothing.

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
was suppressed — **now R-211**; a phone-only guarantor cannot enter their
portal — **now R-216**.

From R-195: only `Lease` and `Deposit` Task routes are exercised end to end.

From R-194: the demo seed's Riverside notice has no demand; nothing drafts a
cure notice from the lease page or the final chase rung.

From R-193: no edit or delete on a property expense; the demo seed records
none.

From R-183: no accrual engine, no interest rate on `JurisdictionRule`.
**D-222 keeps this out of scope.**

From R-173: a tenant with a phone but no email still gets a live PORTAL row
and cannot sign in — **now R-216, and R-210 is the `Notice` half**.

From R-171: `writePayment` dedups only on `stripePaymentIntentId`, so an ACH
payment may write both a `PENDING` and a `SETTLED` row. Recorded as
**unknown** — verify against real Stripe.

From R-170a: `/staff/new` and `/staff/[id]` each take ~21s to axe-scan against
`/staff`'s 2.2s.
