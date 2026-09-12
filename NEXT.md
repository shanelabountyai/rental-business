# Next session

## R-202 is done — `leases.spec.ts` waits for the action, not its first side effect (D-217).

Code `c8e361a`, SHA commit `85a46b4`. **CI run `34702228353` was still
IN PROGRESS when the session ended** — it is on the code commit, which is the
one that matters. Read it before doing anything else:

```
gh run view 34702228353
```

**Do not copy a green CI line forward.** If it failed, that is the first item,
not R-203. `gh run list --commit` only matches a FULL sha and returns EMPTY for
a short one, with no error — use `git rev-parse <short>` first, or watch by id.

## Start here: row 190, R-203

`docs/prds/06-backlog.md` Milestone 14 ("Arc 4"). The **e-sign half of the
payment plan** (D-214). **Re-verify the row's premises first (R-150)** — R-201
found two of four cited sites already fixed, and R-202 found the row's stated
*cause* wrong (see below) while its class held.

## What R-202 changed, and the one premise it corrected

- **`e2e/leases.spec.ts:~740`** now asserts *"A tenancy that restarts is a
  new"* between the click and the `lastSyncAction` poll, plus a **deliberately
  un-polled** `workOrder.count(...)` immediately after it. That count is the
  proof the wait works: revert the wait and it is the line that goes red.
  Do not "tidy" it into a poll.
- **The `afterAll` work-order delete is now scoped by `propertyId`**, not
  `unitId`.
- **The row's stated cause was wrong and PROGRESS records it.** There is no
  outbox consumer creating work orders — `CONSUMERS` has four entries, none
  makes a `WorkOrder`, and `dispatchOutbox` never runs in an e2e sweep. The six
  come from `startTurnoverProjectForLease`, awaited inline; the "beat later"
  was the test outrunning its own action.
- **MEASURED: red 3 runs out of 3 with the wait removed.** The R-179 "flake"
  was never intermittent — only *which test finished last in the worker* was.
  A "flaky" label on a 100%-reproducible race is a shape worth recognising.

## Owned by nobody, from R-202

- **Nothing holds the ordering of the other four side effects** of
  `setLeaseStatus`'s ended branch. The UI wait cannot resolve early whatever
  the order, but the *proof* of it is turn-specific.
- **`accessCode`, `task` and `turnoverProject` deletes in that `afterAll` are
  still keyed off collected ids**, not `propertyId`. None can flake today
  (`AccessCode` carries no `propertyId`; a late `updateMany` on a deleted row
  matches nothing rather than refusing), so they were left alone.
- **Two sibling specs end a tenancy and are safe by accident, not design.**
  `door-codes.spec.ts:163` polls the LAST side effect; `turnover.spec.ts:188`
  waits for rendered text first. D-217 names both so the next side effect
  appended to that branch knows what it can break.

## Still outstanding from R-187, owned by nobody

**The Neon dev branch is nine migrations behind**, back to
`20260904120100_r165_guarantor_actor_type` and including
`20260907120000_r175_payment_plans`, so it has no `PaymentPlan` table at all.
`npm run dev` reads `.env.local`, so a walk against the dev branch would 500 on
anything built since R-165. `npm run db:migrate:dev` is the whole fix; it has
still not been run. **R-203 is the payment plan's other half, so this is now
directly in its way.**

Also from R-187: the start-day boundary double-counts a charge raised on the
plan's own start date; no e2e walks the wrongly-completed warning.

## Binding for every row in this arc

The review's **"do not build"** list, repeated in the Milestone 14 header and
D-201: no accrual or interest engine before a second state; no Stripe Connect;
no settings screen for `CHASE_LADDER_DAYS`, `TURN_STAGE_DAYS`,
`TURN_STALL_DAYS`, `PLAN_GRACE_DAYS` or the stall thresholds; **no second
queue** (D-9); **no backfill of anything**; no per-stage turn table, no second
definition of "days vacant".

## Still true from earlier handoffs

- **Rows 81 (R-081), 97 (R-097) and 155 (R-168) are SPLIT-PARENT
  placeholders.** Every child shipped. Ticking them is bookkeeping.
- **Row 93 (R-093) is externally blocked** — real vendor drivers, each needing
  a signed commercial relationship. Not a laptop item.

## MACHINE CONTENTION — read this before diagnosing a red unit run

R-202's `npm test` was **3166 passed in 39.4s**, so the machine was clean this
session. If a run comes back at 190s+ with `Hook timed out in 10000ms` in files
the item never touched, that is contention, not a regression. Settle it in this
order — it is faster than a stack trace:

1. `psql -c "select count(*) from pg_stat_activity"` → a project holding 30+ is the tell.
2. `ls -lt /Library/Logs/DiagnosticReports/JetsamEvent-*.ips` → no file for the
   relevant minute means the OS killed nothing. `Killed: 9` names no culprit;
   this is the check that does.
3. `sysctl -n kern.memorystatus_level` / `vm.memory_pressure`.
4. `lsof -ti :3100`.
5. **The per-file duration table.** `vendors/follow-up.test.ts` taking ~188s
   and still PASSING is this symptom's tell.
6. `ps` → idle Playwright `test-server` daemons from sibling projects.

**Sibling daemons are not this repo's to kill** — scope every kill to `$PWD`.
Checked by `cwd` this session: `clinic` has held one since 2026-09-11 and
`apptbasedservice` since 2026-09-10. Close them from their own projects.

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a change
touches a form control or page layout (D-194), and whenever a page renders a
user-supplied VALUE (D-197) — the second kind hides from an element-by-element
probe; only `document.documentElement.scrollWidth` sees it.

**Use `npm test -- <path>` and `npm run test:e2e`, never bare `npx vitest` or
`npx playwright test`.** Both give a wall of instant failures with no
`DATABASE_URL`, which reads exactly like the jetsam symptom and is not it.
(`--list` is safe without it, and is how you get the real expected e2e count.)

**Prove a new assertion against the reverted fix** (D-197). R-202 did this and
it changed the finding: 3 of 3, not "sometimes".

**Read the e2e summary, not the tail of it.** The gate is
`passed + skipped + flaky` reconciling against `npx playwright test --list`.

**A seed defect is only visible on a walk** (D-28).

## Leftovers still owned by nobody

From R-201: the deposit-slip PDF title and the §3955 SCRA notice are held by no
test; slips and notices already issued keep the raw date in stored text
(forward-only, D-201); the demo seed creates no deposit batch and records no
SCRA termination, so a D-28 walk can see neither fix.
`consent-panel.tsx:172` is a **KNOWN FALSE POSITIVE — do not "fix" it**;
`friendlyBusinessDate` throws on `friendlyTimestamp` output, which is a 500.

From R-200: non-renewal notices already served carry the wrong end date in
stored `bodyText`; no e2e drives a business-day state through either notice
form; `observedHolidays` is seeded for no state; the demo seed configures Texas
only.

From R-199: a cancelled or broken plan sends the tenant nothing; the staff
lease page does not show where the schedule went; the guarantor portal does not
show the plan.

From R-198: a payment on a property deactivated mid-range is outside the
settlement report; a late-delivered payment in an already-swept range belongs
to no recorded transfer.

From R-196: `sendReminders` reports "sent to N people" even when every channel
was suppressed; a phone-only guarantor cannot enter their portal.

From R-195: only `Lease` and `Deposit` Task routes are exercised end to end;
`demo-seed.mts` writes Task subject strings outside the union.

From R-194: the demo seed's Riverside notice has no demand; nothing drafts a
cure notice from the lease page or the final chase rung.

From R-193: no edit or delete on a property expense; the demo seed records
none, so every house reads "No property tax or insurance booked".

From R-183: no accrual engine, no interest rate on `JurisdictionRule`;
`Deposit.escrowAccountRef` / `interestAccruedCents` are written by nothing.

From R-173: a tenant with a phone but no email still gets a live PORTAL row and
cannot sign in.

From R-171: `writePayment` dedups only on `stripePaymentIntentId`, so an ACH
payment may write both a `PENDING` and a `SETTLED` row. Recorded as **unknown**
— verify against real Stripe.

From R-170a: `/staff/new` and `/staff/[id]` each take ~21s to axe-scan against
`/staff`'s 2.2s.
