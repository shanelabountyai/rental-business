# Next session

## R-190 is done — commit `589bbf0`, SHA recorded in the follow-up.

**CI has NOT been checked for this item.** Run `gh run list --limit 5` and
confirm the run on the SHA-recording commit (auto job cancellation usually
leaves only that one). Do not copy this or any earlier green line forward;
R-141's lesson is eleven entries inheriting a claim instead of running the
three-second command. R-189's own run WAS checked this session and was green
(`34490180475`).

## Start here: row 178, R-191

`docs/prds/06-backlog.md` Milestone 14 ("Arc 4"), rows 174–189, sourced from
`docs/reviews/2026-09-09-operator-review.md` and recorded as D-201. Work top to
bottom; the WRONG rows come first.

**R-191's claim is already verified** — `alreadyFlagged`
(`apps/web/lib/cases/case-stall-job.ts:32-35`) is
`findFirst({ where: { type, subjectId } })` with no status filter, exactly as
the row says, sitting under a comment that defends the *missing `businessDate`*
(which R-158 was right about and which stays). A DONE or CANCELED Task still
matches, so the condition can never raise a second one — sharpest for
`accommodation.response_overdue`, which is EMERGENCY because D-89 says an
unanswered request reads as denied.

**Read R-191 together with R-188's leftover below before fixing either** — same
shape, different table.

Fourteen of the fifteen rows were inherited evidence; findings 1, 3, 4 and 5
have now been verified at build time. R-150's rule stands: re-verify the file
and line before building, and if the claim is wrong, say so in the entry rather
than building around it. R-187 through R-190's claims were all verified and all
correct.

## What R-190 changed that the next rows touch

- **`JobContext.now` is now a documented invariant**: always an instant inside
  `businessDate` at `timezone`. A job must read it, never `new Date()`, for
  anything that decides what day it is. The docstring on the interface in
  `apps/web/lib/jobs/runner.ts` says so at length. D-205.
- `replayInstant(job, timezone, date)` (private to `runner.ts`) is the job's
  own `localHour` on the date being replayed, via `wallClockToUtc`. Both the
  catch-up loop and `rerunJobRun` use it.
- **`rerunJobRun`'s second parameter is gone.** It was `now = new Date()`; no
  caller ever passed it. Signature is now `rerunJobRun(jobRunId)`.
- Four jobs now pass `context.now` through: `ledger.late_fees`,
  `billing.due_notices`, `billing.predebit_notices`,
  `billing.card_expiring_notices`.
- **`billing.sweep` deliberately takes no date** and its header now says so.
  Do not thread `now` into it by reflex; if a date-dependent decision ever
  moves into the sweep, that comment has to go with it.
- `chase-job.test.ts` gained `shiftDay()` and a catch-up test that goes through
  the real `runDueJobs`. Its existing `runOn()` helper still dodges the
  catch-up window on purpose — that docstring is still correct.

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

## Still outstanding from R-188, owned by nobody

The deposit reminder job's already-flagged guard keys on `leaseId`, not on the
deposit, so a lease holding two deposits (SECURITY + PET) flags once for both.
**Same shape as R-191** — an already-flagged guard that cannot fire twice.

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
