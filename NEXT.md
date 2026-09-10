# Next session

## R-192 is done — commit `117a5c0`, SHA recorded in the follow-up.

**CI for R-192 WAS checked and is green** — run `34538278213` on `117a5c0`,
both jobs, read with `gh run list` after the push, not inherited.

**The SHA-record push starts NO run**: `.github/workflows/ci.yml` has
`paths-ignore: ['**.md', 'docs/**']`, so a docs-only commit is skipped and the
code commit's run is the one to read. **Do not copy the green line forward** —
run `gh run list --limit 5` after your own push and write down what it says.

## Start here: row 180, R-193

`docs/prds/06-backlog.md` Milestone 14 ("Arc 4"), sourced from
`docs/reviews/2026-09-09-operator-review.md` §7 and D-201.

**R-193 is an M-sized build: a new `PropertyExpense` table, a hand-written
migration, a staff form, and a feed into R-078's export pipeline so
`/reports/operating`'s "All expenses" and "Net" stop omitting tax, insurance
and management.** It is not a ledger write (D-11); vendor invoices already set
the precedent that owner-side outlay lives in its own table. **Recommend Opus**,
because the figure it corrects ranks houses on the lemon test. Sonnet is
defensible for the form and migration. **Re-verify `reports/operating/page.tsx:196-201`
and `packages/core/tax/packet-document.ts:36` before building** (R-150).
"Optional monthly recurrence" must not become an accrual engine (D-201's do-not-build).
It touches a form and a page, so run `--project=mobile-chrome` too (D-194/D-197).

## What R-192 changed that the next rows touch

- **`writePayment`'s counter-payment claim now requires
  `createdAt >= intent.occurredAt − 2 days`** (`COUNTER_CLAIM_WINDOW_MS`,
  `apps/web/lib/billing/webhook.ts`, D-207). It is a lower bound only, because
  the simulator stamps its event with the backdated `receivedAt`. **Never
  bound it on `receivedAt`**, which reopens D-169 for every backdated cheque.
- **A test that drives the claim must stamp `created` deliberately.**
  `invoiceEvent`'s default `created` is 2027, outside the window, so a "does
  NOT claim" test passes vacuously on the default. That is how the
  online-payment test was silently weakened until R-192 fixed it.
- **`unclaimedCounterPayments(propertyIds)`** is counted on `/money`'s
  Reconciliation drift panel, in red when non-zero. Portfolio-scope only.

## Found in R-192, owned by nobody

- An online payment of the same amount **inside** the two days, on an invoice
  whose counter event was lost, is still claimed. Nothing on the event
  distinguishes the two here, and that cannot be verified from the laptop.
- No e2e seeds a stale counter row; the red line is asserted by nothing on
  screen (unit test covers the count).
- Production frequency of a lost out-of-band event: **unknown**.

## What R-191 changed that the next rows touch

- **`alreadyFlagged(type, subjectId, today)` in `apps/web/lib/tasks/already-flagged.ts`
  is now the ONE "have we raised this?" guard** (D-206). An OPEN/IN_PROGRESS/
  BLOCKED Task suppresses at any age; a DONE/CANCELED one only until its own
  business date + `TASK_REFLAG_COOL_OFF_DAYS` (7). **A new window-watching job
  must call it** — do not hand-write `task.findFirst({ where: { type, subjectId } })`
  a seventh time; that shape was the bug six times over.
- Its six callers: `cases/case-stall-job.ts`, `cases/court-date-reminder-job.ts`,
  `compliance/alert-job.ts`, `leases/renewal-window-job.ts`,
  `leases/renter-insurance-job.ts`, `leases/deposit-disposition-reminder-job.ts`.
- **`deposit.disposition_halfway` / `_overdue` Tasks are now subjected on the
  `Deposit`** (`subjectType: 'Deposit'`), not the lease — same as
  `deposit_refund_due` (D-174). R-188's two-deposits leftover is closed.
- **First run after deploy will re-raise** every still-true condition whose flag
  was closed more than a week ago. Expected; it is the finding surfacing, not a
  backfill.

## Found in R-191, owned by nobody

- The re-raise path is tested through two callers (stall sweep, compliance);
  the other four share the code with no re-raise test of their own.
- `lease_renewal` can now re-raise weekly across a 120-day window (~17 Tasks)
  if somebody keeps closing it unrenewed. Intended, never seen in a queue.
- Court-date T-7/T-1 on a RESCHEDULED hearing is what the status filter buys
  there; untested.

## Found in R-190, owned by nobody

- **The four pass-throughs have no test of their own.** Nothing fails if
  somebody drops the `now` argument back off `sendDueNotices(propertyId, now)`.
  Each needs a lease-plus-payer fixture to prove — a fixture per job for a
  one-line call site. The comments name R-190 at each one instead.
- **Nothing re-raises the chase rungs a past cron gap ate**, and past `JobRun`
  rows still claim those days SUCCEEDED. D-201's standing no-backfill.
- **The catch-up now genuinely replays the day, which is a production
  behaviour change.** A three-day gap sends three days of correctly-dated due
  notices in one tick rather than one day's sent three times.
  `CATCH_UP_BUSINESS_DAYS = 3` is the only thing bounding that.
- **The sixteen jobs that already read `businessDate` are now silently more
  correct on a catch-up** — the digest's `createdAt: { lt: now }` window in
  particular now closes at the replayed day. Untested per job.

## The hook-timeout flake, and what actually caused it

Two full unit runs failed this session with **`Hook timed out in 10000ms`** in
a cleanup hook — `maintenance/emergency.test.ts`'s `afterAll` on the first,
`listings/delist.test.ts`'s `afterEach` on the second. Different files, same
10s ceiling, and a suite that ran **135s then 61s against a 19.5s baseline**.

**It was contention on this machine, not the code, and the way that was settled
is worth copying.** `pg_stat_activity` showed six connections total, so no
sibling project was implicated; stashing the work and running the clean tree
gave 3090 passed in 19.5s, which looked like proof the change was at fault.
It was not — the per-file table showed **everything** slower, including
`vendors/follow-up.test.ts` (18.7s → 58s) and `workorders/chargeback-actions`,
neither of which touches a job. A global slowdown across unrelated files is
machine contention. Re-running with the change applied and **nothing running
alongside it** gave 3091 passed in 21.9s, green.

So: `npm run lint` and `npm run typecheck` alongside a full `npm test` is
enough to tip these hooks over. Run the suite on its own. **The ceiling is
still real** — seven sequential `deleteMany`s against vitest's default 10s
hook timeout has no headroom, the R-040e/R-102b shape — and **it has no row**.

## Still outstanding from R-187, owned by nobody

**The Neon dev branch is nine migrations behind**, back to
`20260904120100_r165_guarantor_actor_type` and including
`20260907120000_r175_payment_plans`, so it has no `PaymentPlan` table at all.
`npm run dev` reads `.env.local`, so a walk against the dev branch would 500 on
anything built since R-165. `npm run db:migrate:dev` is the whole fix; it was
outside R-187 through R-190's scope and has still not been run.

Also from R-187: the start-day boundary double-counts a charge raised on the
plan's own start date (it lands in both `arrearsCents` and `chargesSince`); no
e2e walks the new wrongly-completed warning.

## Still outstanding from R-189, owned by nobody

- Nothing backfills the photographs discarded before that item — those bytes
  were never fetched and no longer exist to fetch.
- Nothing re-parents a photograph onto a ticket opened AFTER the message that
  carried it.
- The filename is manufactured (`texted-1.jpeg`) because Twilio sends none.
- The memory ceiling on a media fetch is one CDN response bounded by the
  timeout; a lying `Content-Length` is only caught after buffering.
- The wire between the fetcher and Twilio is untested and cannot be tested from
  here — same limit R-104's drivers have.

## Binding for every row in this arc

The review's **"do not build"** list, now three arcs deep and repeated in the
Milestone 14 header and D-201:

- No accrual or interest engine before a second state is onboarded.
- No Stripe Connect. Still a legal-structure decision nobody has taken.
- No settings screen for `CHASE_LADDER_DAYS`, `TURN_STAGE_DAYS`,
  `TURN_STALL_DAYS`, `PLAN_GRACE_DAYS` or the stall thresholds.
- **No second queue.** D-9 has been paid for three times. R-191 and R-197 want
  the *existing* Task queue reachable and correctly dated.
- **No backfill of anything** — D-169's doubled `Payment` rows, R-038a's
  no-ledger payments, R-187's wrongly-completed plans, R-189's discarded
  photographs, and now R-190's lost chase rungs.
- No per-stage turn table, no second definition of "days vacant".

**R-194** is the arc's other Needs counsel row (does a partial payment cure, and
does accepting it waive — the second is already a three-valued
`JurisdictionRule` field). **R-192 records its production frequency as unknown**
— code path verified, frequency not, pending real Stripe redelivery behaviour.

## Still true from earlier handoffs

- **Rows 81 (R-081), 97 (R-097) and 155 (R-168) are SPLIT-PARENT
  placeholders.** Every child shipped. Ticking them is bookkeeping.
- **Row 93 (R-093) is externally blocked** — real vendor drivers, each needing
  a signed commercial relationship. Not a laptop item.
- **`e2e/leases.spec.ts`'s cleanup flake has a row** — 189 / R-202, at the end
  of the arc. It costs CI time on every push, so pull it forward if a sweep
  goes red on `WorkOrder_unitId_fkey` rather than treating it as new.

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a change
touches a form control or page layout (D-194), and whenever a page renders a
user-supplied VALUE (D-197) — the second kind hides from an element-by-element
probe; only `document.documentElement.scrollWidth` sees it.

**Use `npm test -- <path>` and `npm run test:e2e`, never bare `npx vitest` or
`npx playwright test`.** Both give a wall of instant failures with no
`DATABASE_URL`, which reads exactly like the jetsam symptom CLAUDE.md warns
about and is not it. R-190 hit the vitest half of this. (`--list` is safe
without it, and is how you get the real expected e2e test count.)

**Prove a new assertion against the reverted fix** (D-197). R-190 did this
three times, one revert per claim, and each turned exactly one test red.

**A fixture that looks complete can still be missing the field under test.**
Check what the production writer sets, not what the fixture has.

**A wall of hook timeouts in unrelated `afterAll`s is an environment symptom.**
Check `pg_stat_activity` for sibling projects before reading a stack trace.

**A seed defect is only visible on a walk** (D-28).

## Leftovers still owned by nobody

From R-186: the demo's lease term is `startsInDays + termMonths * 30`, so a
twelve-month lease reads *30 Sept 2026 to 25 Sept 2027*; the seeded draft has
no utilities and no addenda; the staff-side `/leases/[id]` e-sign panel was
never walked in a browser; `storageIsRemote` skips the draft document, so with
`BLOB_READ_WRITE_TOKEN` set the defect returns.

From R-185: `packages/core` can test the catalogue EXAMPLES but not the values
— the three builders are `server-only` Prisma modules in `apps/web`.
`demoLeaseMergeValues` is the only tested one. `rent.due_day` still renders as
a bare `'1'` rather than `'the 1st'`, left alone deliberately.

From R-184: `leaseStatusLabel`'s `/money` caller has no tests; `from
{prospect.source}` prints the raw column, so the prospect header reads
"Applied · from zillow"; `/workorders/[id]/timeline` was the one route family
the phone-width pass skipped.

From R-183: no accrual engine, no interest rate on `JurisdictionRule`, and
`Deposit.escrowAccountRef` / `interestAccruedCents` are written by nothing —
deliberate, and not to be started until such a property is onboarded.

From R-182: `assessEvidence`'s presumption period takes no day-count basis, and
nothing seeds a holiday list for any state.

From R-181: a texted-in tenant never gets the quotable reference; the
acknowledgement rides the hourly outbox cron so it can lag an hour;
`entry.notice` names no ticket; no e2e walks intake → acknowledgement.

From R-180: no processing fee, so no net payout can be stated; `HAP_ACH` would
be counted as a Stripe settlement if anything wrote it.

From R-178: no `cases.stalled` Task links to its subject; `TURN_STAGE_DAYS`
unconfigurable; `draftPunchListFromInspection` findings are unstaged.

From R-177: the R-032c "was this fixed?" SMS default and the TCPA question are
owner decisions, recorded and unfixed. Email-intake tickets get no clarify
link; `e2e/maintenance-phone-log.spec.ts` cleans up by collected-id list.

From R-176: nothing warns portfolio-wide that a unit was listed with an open
re-key; a CANCELED re-key reads like one that never happened.

From R-173: a tenant with a phone but no email still gets a live PORTAL row and
cannot sign in.

From R-172: no staff field for a real handover date on an inherited tenancy;
`apps/web/lib/turnover/queries.test.ts` cleans up by collected-id list.

From R-171: `writePayment` dedups only on `stripePaymentIntentId`, so an ACH
payment may write both a `PENDING` and a `SETTLED` row. Recorded as **unknown**
— verify against real Stripe. (R-192 is the adjacent, verified defect.)

From R-170a: `/staff/new` and `/staff/[id]` each take ~21s to axe-scan against
`/staff`'s 2.2s.
