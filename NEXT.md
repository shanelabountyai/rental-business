# Next session

## R-188 is done and pushed — `f503a14`, SHA recorded in `bd7762c`.

**CI has NOT been checked for this item.** Run `gh run list --limit 5` and
confirm both jobs on `bd7762c` (or `f503a14` — auto job cancellation usually
leaves only the SHA commit's run). Do not copy this or any earlier green line
forward; R-141's lesson is eleven entries inheriting a claim instead of running
the three-second command.

## Start here: row 176, R-189

`docs/prds/06-backlog.md` Milestone 14 ("Arc 4"), rows 174–189, sourced from
`docs/reviews/2026-09-09-operator-review.md` and recorded as D-201. Work top to
bottom; the WRONG rows come first. R-189 is the next one — the photograph a
tenant texts at 11pm is discarded at the door (`app/api/sms/inbound/route.ts`
reads only `From`/`Body`/`MessageSid`, while the email path has stored and
re-parented the same photo since R-097d). Review finding 3.

Thirteen of the fifteen rows are **inherited evidence**; only findings 1 and 5
were spot-checked at planning time. R-150's rule stands: re-verify the file and
line before building, and if the claim is wrong, say so in the entry rather
than building around it. R-187's and R-188's claims were both verified and both
correct.

## What R-188 changed that the next rows touch

- Both deadline surfaces on `Deposit` — `deposit-disposition-reminder-job.ts`
  and `upcomingCriticalDates` in `reports/queries.ts` — now take
  `OR: [{ dispositionSentAt: null }, { refundPaidOn: null, refundedCents: { gt: 0 } }]`.
  Their labels branch on `dispositionSentAt` to say *Deposit refund* vs
  *Deposit disposition*. D-203.
- `deposit_refund_due` Tasks are now dated `dispositionDueOn` rather than the
  day the letter was finalized, and name that date in the title. Anything
  asserting on that Task's `businessDate` or title should expect the deadline.
- `e2e/deposit-disposition.spec.ts`'s deposit fixture now seeds
  `dispositionDueOn: 2026-09-14`; it previously had none despite having a
  `moveOutAt`.
- **No new task type and no new `CriticalDateKind`** was added — R-191 (row 178)
  also wants the existing Task queue behaving correctly, not another vocabulary.

## Found in R-188, owned by nobody

The reminder job's already-flagged guard keys on `leaseId`, not on the deposit,
so a lease holding two deposits (SECURITY + PET) flags once for both.
Pre-existing and untouched.

**Still open and named in D-203:** whether a timely itemization with a late
refund is a partial defence is a question for counsel. It gated nothing — the
code shows the date either way — so no owner question was asked.

## Still outstanding from R-187, owned by nobody

**The Neon dev branch is nine migrations behind**, back to
`20260904120100_r165_guarantor_actor_type` and including
`20260907120000_r175_payment_plans`, so it has no `PaymentPlan` table at all.
`npm run dev` reads `.env.local`, so a walk against the dev branch would 500 on
anything built since R-165. `npm run db:migrate:dev` is the whole fix; it was
outside both R-187's and R-188's scope and has still not been run.

Also from R-187: the start-day boundary double-counts a charge raised on the
plan's own start date (it lands in both `arrearsCents` and `chargesSince`); no
e2e walks the new wrongly-completed warning.

## Binding for every row in this arc

The review's **"do not build"** list, now three arcs deep and repeated in the
Milestone 14 header and D-201:

- No accrual or interest engine before a second state is onboarded.
- No Stripe Connect. Still a legal-structure decision nobody has taken.
- No settings screen for `CHASE_LADDER_DAYS`, `TURN_STAGE_DAYS`,
  `TURN_STALL_DAYS`, `PLAN_GRACE_DAYS` or the stall thresholds.
- **No second queue.** D-9 has been paid for three times. R-191 and R-197 want
  the *existing* Task queue reachable and correctly dated — R-188 just did that
  half for deposits without adding a type.
- **No backfill of anything** — D-169's doubled `Payment` rows, R-038a's
  no-ledger payments, and the plans R-187 left named rather than rewritten.
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

**Use `npm run test:e2e`, never bare `npx playwright test`.** The latter gives
28 failures in 0–222ms with no `DATABASE_URL`, which reads exactly like the
jetsam symptom CLAUDE.md warns about and is not it.

**Prove a new assertion against the reverted fix** (D-197). R-188 did this
twice, one revert per term of the new `where` clause — which is what showed the
two new tests were guarding different things rather than the same thing twice.

**A fixture that looks complete can still be missing the field under test.**
R-188's first e2e run failed on `Expected: null` because the deposit fixture had
a `moveOutAt` and no `dispositionDueOn` — the field the real move-out flow
stamps. Check what the production writer sets, not what the fixture has.

**A wall of hook timeouts in unrelated `afterAll`s is an environment symptom.**
Check `pg_stat_activity` for sibling projects before reading a stack trace.
R-188's own full unit run was clean (3076/0/4).

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
