# Next session

## R-199 is done — an agreed payment plan sends its schedule and shows on the portal (D-214).

SHA and CI run are recorded in PROGRESS. **Do not copy a green CI line
forward** — run `gh run list --limit 5` after your own push.

## Start here: row 187, R-200

`docs/prds/06-backlog.md` Milestone 14 ("Arc 4"). **LEASE-12's and LEASE-09's
notice checks read `dayCountBasis`.** `noticePeriodCheck`
(`packages/core/leases/notice-to-vacate.ts`) and `renewalCheck` count days as
`Math.floor((effectiveOn − givenOn) / 86_400_000)`, deaf to `BUSINESS` and
`CALENDAR_ROLL_FORWARD`; route them through R-182's `statutoryDeadline`.
`assessEvidence`'s abandonment presumption is the same shape. Core
arithmetic, correctness-critical. Re-verify the row's premises first (R-150)
— the line numbers are from the 2026-09-09 review.

## What R-199 changed that the next rows touch

- **New LOCKED notification category `payment_plan`** and template
  `payment_plan.agreed`. `CATEGORY_LABELS` is exhaustive, so typecheck
  already forced the label; the email opt-out confirmation now lists it among
  what still arrives.
- **`chaseParties` lives in `apps/web/lib/payments/chase-parties.ts`**, not
  inside `reminders.ts` (which is `'use server'` and cannot export it). The
  chase and the plan share it — do not copy it a third time.
- **`agreePaymentPlan`'s notice now ends with who the schedule reached** by
  EMAIL or SMS, or "Not sent to … give them a copy yourself". A PORTAL row is
  deliberately not counted as reaching anyone (R-173).
- **The portal home has a "Your repayment plan" region** (ACTIVE plan only).
  Any new portal-home heading must not collide with it.
- **The e-sign half is row 190, R-203** (owner decision, D-214).

## Found in R-199, owned by nobody

- A cancelled or broken plan sends the tenant nothing; they learn the chase
  resumed from the chase itself.
- The staff lease page does not show where the schedule went — only the
  press's notice says so, then the send log.
- The notice counts QUEUED/DEFERRED at press time; a later bounce is not
  reflected anywhere on the plan.
- The guarantor portal does not show the plan; an ended plan is gone from the
  tenant portal (its message stays in their updates).
- The demo seed agrees no plan, so a D-28 walk cannot see either half.
- `sms-intake.test.ts`'s `afterAll` timed out at 10s twice (once beside lint
  and typecheck, once alone), then passed twice alone on the same tree and in
  the full suite, with nothing else on the database. Cause unknown; the
  hook-timeout ceiling below, a third file.

## What R-198 changed that the next rows touch

- **`EntitySettlement` is append-only by trigger** and holds its `LegalEntity`,
  `Document` and `StaffUser` by RESTRICT. A test that records one cannot delete
  any of the three — retire them.
- **Two new document types, `DEPOSIT_SLIP` and `SETTLEMENT_REPORT`**, both in
  `UNUPLOADABLE_DOCUMENT_TYPES`. `DEPOSIT_SLIP` was being written since R-166
  without being in the vocabulary; a new minted-document type must be added
  to all four lists in `documents/validate.ts` and `retention.ts`.
- **`recordedSettlements(entityIds, from, to, db?)`** is the one overlap
  predicate for recorded transfers. Do not hand-write a second one.
- **The Prisma model `EntitySettlement` is not core's `EntitySettlement`
  interface** (the computed share). Nothing imports both today.
- New audit action `settlement.transfer_recorded`.

## Found in R-198, owned by nobody

- A payment on a property deactivated mid-range is outside the settlement
  report (`currentScope` reads active properties only), and now outside the
  archived report too.
- A late-delivered payment whose settlement date falls in an already-swept
  range belongs to no recorded transfer; nothing flags it.
- No per-entity list of recorded transfers; nothing reconciles one against the
  bank. A raced overlap leaves an orphaned PDF object in storage.
- The demo seed records no transfer.

## What R-197 changed that the next rows touch

- **A portfolio-wide manager now reaches `/jobs`, the re-run, and the
  `job_failed` Task link.** A property-scoped manager is still refused
  (resource-less guard, unchanged).
- **A role-permission change reaches a database only through `db:seed`.**
  `vercel-build` does not run it. Whether production is re-seeded on deploy
  was not found recorded anywhere, so check before assuming.

## What R-196 changed that the next rows touch

- **`TenantConsent` has two subject keys now**: `tenantId` is nullable beside
  `guarantorId`, with the CHECK `TenantConsent_one_subject` (exactly one).
  Anything reading `row.tenant` must handle a guarantor row, where it is null.
  Any fixture creating a consent row must name one person.
- **`notify()` drops PORTAL for a `GUARANTOR` recipient** (`channelsFor` in
  `send.ts`). A guarantor rent chase writes EMAIL and SMS rows only. If a
  guarantor inbox is ever built, that function is where PORTAL comes back.
- **`recordConsent` reads `party` = `TENANT:<id>` / `GUARANTOR:<id>`**, not
  `tenantId`. The panel field is "Who agreed to be contacted".
- **No guarantor has consent until staff record it** (D-211, no backfill). A
  guarantor text is still `no_consent` by default.

## Found in R-196, owned by nobody

- `sendReminders` reports "sent to N people" even when every one of a person's
  channels was suppressed.
- The guarantor portal shows no consent record and offers no withdrawal, and a
  guarantor has no notification preferences anyone can set.
- The guarantor sign-in link is email-only, so a phone-only guarantor cannot
  enter their portal at all.
- Whether STAFF or VENDOR PORTAL rows have a reader was not checked.

## What R-195 changed that the next rows touch

- **`TaskInput.subjectType` is now `TaskSubjectType`** (core,
  `TASK_SUBJECT_TYPES`). A producer with a new subject type must add it there
  AND a row in `SUBJECT_ROUTES` (`apps/web/lib/tasks/subject-link.ts`) or
  typecheck fails — that is the point (D-210). `type` stays free-form.
- **`subjectLinks(tasks)`** is the one way a page links a Task to its subject.
  Gated on the TARGET page's read permission; do not hand-write a per-type
  branch on a page again.
- `TaskWithProperty.property` now carries `legalEntityId`.
- The deposit link's name is now "Open the deposit disposition".

## Found in R-195, owned by nobody

- Only `Lease` and `Deposit` routes are exercised end to end; the other
  seventeen are held by typecheck alone.
- A `serve_notice_offline` task still cannot reach its notice — its
  `subjectId` is an idempotency key.
- `demo-seed.mts` writes Task subject strings outside the union; an unrouted
  one is silently unlinked.

## What R-194 changed that the next rows touch

- **The product can now create a cure notice** — `draftCureNotice` on
  `/evictions/[id]`, NOTICE stage only. Before it, no real case could reach
  FILING (D-209). R-083's "R-051 already generates pay-or-quit notices" was
  wrong; left as history, corrected in D-209 and PROGRESS.
- **`allocateBalance` in `packages/core/ledger/aging.ts` is the ONE
  newest-first allocation.** `delinquencyFor` and `cureDemand` both call it —
  anything else asking "which debts is this balance still sitting on?" must
  too, not a third copy.
- **`Notice.demandedCents` / `demandComposition` are set at INSERT and frozen**
  by R-161's trigger (not on its write-once list). CHECK
  `Notice_demand_shape`: both or neither, positive total.
- **Two new three-valued `JurisdictionRule` fields**,
  `cureDemandMayIncludeFees` and `partialPaymentCures`, now on the rule form,
  the clone prefill, and `computeCoverage`'s unreviewed list. `RuleCoverageLike`
  requires both, so any hand-built fixture must pass them.
- `PacketFacts` requires `cureVerdict: string | null`.
- New audit action `notice.drafted`.

## Found in R-194, owned by nobody

- **The demo seed's Riverside notice has no demand**, so a D-28 walk shows
  "created before the product recorded what a notice demanded". The seed
  writes it before the Stripe replay builds a balance.
- Nothing drafts a cure notice from the lease page or the final chase rung
  (`CHASE_RUNG_LABELS[15]` says "final chase before a notice"); a case must be
  opened first.
- Pet rent is counted as rent — a product reading, not counsel's.
- Payments earlier on the drafting day are counted toward the cure, which can
  over-credit a tenant (the cheap direction, stated in D-209).
- A Stripe credit that is not a ledger entry is invisible to the demand
  (R-156's same seam).

## Binding for every row in this arc

The review's **"do not build"** list, repeated in the Milestone 14 header and
D-201: no accrual or interest engine before a second state; no Stripe Connect;
no settings screen for `CHASE_LADDER_DAYS`, `TURN_STAGE_DAYS`,
`TURN_STALL_DAYS`, `PLAN_GRACE_DAYS` or the stall thresholds; **no second
queue** (D-9); **no backfill of anything**; no per-stage turn table, no second
definition of "days vacant".

## What R-193 changed that the next rows touch

- **`PropertyExpense` is a second write path to the same Schedule E lines as
  D-76's vendor-invoice splits** (D-208). The owner chose it knowingly;
  nothing detects a bill entered on both.
- **`TaxExportFacts` now requires `propertyExpenses` and `asOf`.** Any new
  fixture or caller building facts by hand must pass both.
- **The export's reconciliation identity is now
  `mapped + excepted + outOfYear + capitalised + splitInvoiced === facts + repeated`.**
  A monthly expense is one fact and several lines.
- **A monthly expense is expanded on read through today** — never write rows
  ahead (D-201). A future `paidOn` is refused at the write.
- `UNFILLABLE_NOTE` is gone; `unfilledLinesNote(filled)` derives it.
- `/reports/operating` carries `missingFixedCosts` per property (tax, insurance).

## Found in R-193, owned by nobody

- The vendor-invoice form does not point back at `/money/expenses`, so the
  duplicate-entry warning runs one way only.
- No edit or delete on a property expense; a series can only be stopped as of today.
- The demo seed records no property expense, so a D-28 walk shows every house
  flagged "No property tax or insurance booked".
- An entity-wide row appears on a property-scoped manager's exception list,
  and its receipt is refused to them by the document route's entity branch.

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
