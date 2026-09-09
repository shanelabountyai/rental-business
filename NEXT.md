# Next session

## R-187 is done and pushed — `e62ad53`, SHA recorded in `5d5ce5e`.

**CI has NOT been checked for this item.** Run `gh run list --limit 5` and
confirm both jobs on `5d5ce5e` (or `e62ad53` — auto job cancellation usually
leaves only the SHA commit's run). Do not copy this or any earlier green line
forward; R-141's lesson is eleven entries inheriting a claim instead of running
the three-second command.

## Start here: row 175, R-188

`docs/prds/06-backlog.md` Milestone 14 ("Arc 4"), rows 174–189, sourced from
`docs/reviews/2026-09-09-operator-review.md` and recorded as D-201. Work top to
bottom; the WRONG rows come first. R-188 is the next one.

**R-188 is one of the arc's two Needs counsel rows** — does a timely
itemization with a late refund partially defend? Read the row and the review
section before deciding whether it can be built without an owner answer, and
ask as a clickable question if it cannot.

Thirteen of the fifteen rows are **inherited evidence**; only findings 1 and 5
were spot-checked at planning time. R-150's rule stands: re-verify the file and
line before building, and if the claim is wrong, say so in the entry rather
than building around it. R-187's claim was verified and was correct.

## What R-187 changed that the next rows touch

- `paidTowardPlan` (`apps/web/lib/payments/plans.ts`) is now
  `-(PAYMENT + CHARGE + REVERSAL)` since `startedOn`, floored at zero, over an
  **allowlist** of types. CREDIT and ADJUSTMENT are both out. D-202 records it
  and corrects D-181.
- `toPlanView` bounds an **ended** plan's window at
  `completedAt ?? brokenAt ?? cancelledAt`. A live plan takes no bound.
- The lease plan panel names any plan recorded `COMPLETED` whose ledger cannot
  support it. **Nothing was backfilled** and nothing should be.
- **R-199 (row 186) depends on R-187** and is now unblocked.

## Found in R-187, owned by nobody

**The Neon dev branch is nine migrations behind**, back to
`20260904120100_r165_guarantor_actor_type` and including
`20260907120000_r175_payment_plans`, so it has no `PaymentPlan` table at all.
`npm run dev` reads `.env.local`, so a walk against the dev branch would 500 on
anything built since R-165. `npm run db:migrate:dev` is the whole fix; it was
outside R-187's scope and was not run.

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
- **No second queue.** D-9 has been paid for three times. R-188, R-195 and
  R-197 all want the *existing* Task queue reachable and correctly dated.
- **No backfill of anything** — D-169's doubled `Payment` rows, R-038a's
  no-ledger payments, and the plans R-187 left named rather than rewritten.
- No per-stage turn table, no second definition of "days vacant".

**R-194** is the other Needs counsel row (does a partial payment cure, and does
accepting it waive — the second is already a three-valued `JurisdictionRule`
field). **R-192 records its production frequency as unknown** — code path
verified, frequency not, pending real Stripe redelivery behaviour.

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

**Prove a new assertion against the reverted fix** (D-197). R-187 did this by
removing only the `CHARGE` term: both new sweep tests went red, which is what
made them worth adding.

**A wall of hook timeouts in unrelated `afterAll`s is an environment symptom.**
R-187's full unit run showed three such files; all three passed in isolation
and `pg_stat_activity` had sibling projects holding 17 connections between
them. Check that before reading a stack trace.

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
