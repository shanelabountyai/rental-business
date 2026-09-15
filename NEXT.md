# Next session

## R-207 is done. Pick up R-208 — the move-in condition report nothing creates.

R-207 shipped as `cb07374` (SHA recorded in `183937b`). **CI run
`35002916707` is GREEN on both jobs** — read it on the run itself,
`gh run view 35002916707`. **Do not copy a CI line forward**; that error cost
eleven items (R-130–R-140).

**Two things make `gh run list --commit` lie, and R-207 hit the second.**
It matches only a FULL sha and returns empty for a short one with no error.
And `.github/workflows/ci.yml` carries `paths-ignore: ['**.md', 'docs/**']`,
so a **docs-only commit legitimately has NO RUN** — `183937b` and `64dde74`
both do. Check what the commit touched before reading an empty result as a
dead pipeline. (R-206's entry shows a run against its own SHA commit only
because that push carried both commits at once.)

**Start here:** `docs/prds/06-backlog.md` → row 195 / **R-208**. The review is
verbatim at `docs/reviews/2026-09-13-operator-review.md` §4; D-222 holds the
binding "do not build" list, and it explicitly forbids a move-in inspection
that BLOCKS occupancy.

## R-208, concretely

A `MOVE_IN` inspection is created in exactly one place — a staff member
pressing a button (`apps/web/lib/inspections/actions.ts:85,130`). Lease
activation creates none. The apparent safety net is not one:
`inspection.move_in_overdue` selects
`{ type: 'MOVE_IN', selfGuided: true, performedAt: null }`
(`apps/web/lib/inspections/auto-finalize-job.ts:122-130`) — **it needs the row
to exist before it can complain nobody walked it**. The asymmetry is provable
in two filenames: `pre-move-out-scheduling-job.ts:78` creates its inspection
automatically and there is no move-in equivalent.

What it costs is the whole deposit case: `move-out-copy.ts:39` builds
R-070/R-151's side-by-side from `{ leaseId, type: 'MOVE_IN' }`, so with none
the comparison has nothing on the left and every deduction trips
`isUnsupportedDeduction` (`packages/core/ledger/disposition.ts:95-105`).

Fix: raise the MOVE_IN inspection on lease activation (blank, `selfGuided` per
the tenant's arrangement) so the existing overdue job has something to watch,
and loudly warn on the access-code release while no move-in report exists
(`apps/web/lib/leases/deposit-clearing-job.ts:103-111` is where that Task is
raised today, and it says nothing about a walk). **Warn, never block** —
D-187's posture, and D-222 makes it binding: a family must not be stopped
moving in on a Saturday because nobody pressed a button. **Needs counsel** on
penalty exposure, not on the gap — not blocked on an answer to start.

**"Lease activation" is FOUR call sites, not one — check before you hook it.**
`leaseTransition()` in `packages/core/leases` is the shared *decider*, not the
writer: each caller writes for itself. `apps/web/lib/leases/actions.ts:465`
(the manual "Make this lease active"), `esign-actions.ts` (the tenant finishes
signing), `esign-staff-actions.ts:151` and `renewal-cutover-job.ts:60` all
call it. A hook added to only one of them means a lease signed in the portal
gets a move-in report and one activated by hand does not. Find the common
write, or add it to all four and say in the entry that you checked.

## What R-207 left behind

- **`urgent` does not reach `scheduleRetry`, so a bounced emergency is still
  retried at 08:00.** The flag is a fact about the SEND and nothing persists
  it; a retry runs from the stored row, which knows only its category.
  Narrower than what R-207 fixed (that held *every* emergency dispatch, this
  holds only the ones a provider bounced), and closing it means a column on
  `Notification` plus a migration. The comment at `scheduleRetry` in
  `apps/web/lib/notifications/send.ts` names it. Owned by nobody.
- **`plan-actions.ts:258` counts a DEFERRED outcome as "on its way"** and says
  `The written schedule is on its way to …` for a message held until 08:00.
  Same shape as the screen half R-207 fixed, different screen. R-211 owns the
  neighbouring `sendReminders` version.
- The bid-request send in `approvals.ts` sets no `urgent` and still defers.
  Deliberate: there is no emergency whose right move is to gather three bids.
- No e2e drives `dispatchToVendor`'s notice; the deferred branch needs the
  wall clock inside quiet hours, which is why the cover is a unit test on the
  pure `vendorDispatchNotice`.

## The fixture rule has now paid off four times in three items

R-205 fixed `rent-roll.spec.ts` (UTC midnight reads as the previous local
day). R-206's gate went red in `evictions.spec.ts`, a file it never opened.
**Before trusting any fixture that writes a `LedgerEntry` by hand, check
`chargeId` and check the hour.** R-208 writes inspections, not ledger rows,
but the class is the same: **shape a fixture like the thing production
actually writes.**

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a
change touches a form control or page layout (D-194), and whenever a page
renders a user-supplied VALUE (D-197). Locally `npm run test:e2e` runs BOTH
already, so `--list` is how you get the real expected number.

**Use `npm test -- <path>` and `npm run test:e2e`, never bare `npx vitest` or
`npx playwright test`** (`--list` is safe without it). And in **zsh an
unquoted `$F` does not word-split** — spell the paths out.

**Prove a new assertion against the reverted fix** (D-197). R-202 through
R-207 all did.

**Read the e2e summary, not the tail of it.** The gate is
`passed + skipped + flaky` reconciling against `npx playwright test --list`.

**`npm run db:ci` before pushing a migration.** R-208 may need none (the
`Inspection` model already exists); R-217 (`habitabilityRepairDays` on
`JurisdictionRule`) does.

**A `'use server'` module may export only async functions, and that includes a
type re-export.** R-207 hit this from the other side: the pure notice-builder
had to leave `actions.ts` for its own module. `npm run build` is the only
check that catches it.

## MACHINE CONTENTION — read this before diagnosing a red unit run

R-206's first `npm test` came back **5 files red on `Hook timed out in
10000ms`** in files the item never opened; the five passed in **1.6s** alone
and the clean re-run was 3,185 passed. That is contention, not a regression.
R-207's unit runs were clean first time at **3,190 passed / 4 skipped**. The
checks, in order:

1. `psql -d postgres -c "select datname, count(*) from pg_stat_activity group by datname"` → a project holding 30+ is the tell.
2. `ls -lt /Library/Logs/DiagnosticReports/JetsamEvent-*.ips` → no file for the relevant minute means the OS killed nothing. `Killed: 9` names no culprit.
3. `sysctl -n kern.memorystatus_level` / `vm.memory_pressure`.
4. `lsof -ti :3100`.
5. **The per-file duration table.** A file taking ~188s and still PASSING is this symptom's tell.

**Sibling daemons are not this repo's to kill** — scope every kill to `$PWD`.

## Rules that bind this arc specifically

- **Re-verify every finding against the code before touching anything.**
  Findings 1, 2 and 3 were spot-checked during planning; twelve are inherited
  evidence. R-205, R-206 and R-207 all re-verified and all three were correct
  as written — R-207's line numbers matched exactly.
- **Never backfill.** Report the history, fix the writer, leave reconciled
  rows alone. D-201 already paid for this lesson. It bites R-208 directly:
  do not create MOVE_IN rows for leases already active.
- **Three rows still Needs counsel** (R-208, R-213, R-217); none is blocked on
  an answer to start.
- **D-222's "do not build" list is binding**: no Stripe Connect, no
  house-rules settings screen, no second queue (D-9), no deposit interest
  engine, no `businessDaysBetween` rewrite, and **no move-in inspection that
  BLOCKS occupancy** — that one is R-208's own constraint.

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

From R-206: the chase ladder fires once per arrears EPISODE, not once per
unpaid period (`chaseRungDue` matches days past grace exactly against
`[1, 5, 15]` off one anchor per lease), recorded as D-224;
`webhook.ts:296` can put fee money in an unlinked `CHARGE` entry when
`fits = linkedTotal <= movedCents` is false, double-counting the debit side
and moving the anchor NEWER (understating, the safe half); a balance moved by
an `ADJUSTMENT` with no charge behind it still falls through to the oldest
known debt (deliberate); `late-fees.ts` pass 2 deliberately does not use
`rentDebtsFor`.

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
