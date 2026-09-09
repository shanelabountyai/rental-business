# Next session

## Arc 4 planning is done and pushed — `cea6d56`, docs only.

**R-186's CI came back GREEN** — run `34391093789` on `34a4d8b`, both jobs
(`Lint, types, unit tests, build` and `End-to-end, axe, Lighthouse`). That
closes the question the last handoff left open. `cea6d56` is docs-only, so
`.github/workflows/ci.yml`'s `paths-ignore` means it correctly has no run and
`apps/web/vercel.json`'s `ignoreCommand` correctly skips the deploy.

**Do not copy that green line forward.** Run `gh run list --limit 5` yourself.
R-141's lesson is eleven entries inheriting a CI claim instead of running the
three-second command.

## Start here: row 174, R-187

`docs/prds/06-backlog.md` Milestone 14 ("Arc 4"), rows 174–189, sourced from
`docs/reviews/2026-09-09-operator-review.md` and recorded as D-201. Work top to
bottom; the six WRONG rows come first.

**R-187 — a repayment plan counts ordinary rent as instalment money, so it can
never break and eventually completes itself.** M. Model: **Opus** — money math
with a legal-evidence consequence.

`paidTowardPlan` (`apps/web/lib/payments/plans.ts:50-67`) credits every
`PAYMENT`/`CREDIT` on the lease since `startedOn` and nothing subtracts the
rent charged in between. D-181's comment states the algebra and drops a term:
the charges cancel only if subtracted from `paymentsSince` too, so the correct
predicate is `paymentsSince − chargesSince >= cumulativeMatured`. A $2,400 plan
of six $400 instalments, against a tenant paying only their ordinary $1,500
rent, reads `ACTIVE` with `shortfallCents: 0` and **`COMPLETED`** by month six —
while `payment_plan`'s `halt_dunning` + `halt_late_fees`
(`packages/core/holds/index.ts:131-137`) keep the ladder and the late-fee meter
off for the whole run, and `payment-plan-job.ts:77-110` then raises a ROUTINE
*"plan paid in full"* Task. Also drop `CREDIT` from the count, for D-181's own
stated reason: a concession is us.

**I verified this one myself** — `plans.ts:50-67` has no charge term anywhere.
The row is not inherited on this point. **Do not backfill** the plans already
completed wrongly (review's "do not build"): report them, fix the writer.

## What Arc 4 is, in one line

Arc 3 made money physically leave the building. This review found the product
now writes **confident records that are wrong** — a plan that completes itself,
a `JobRun` marked SUCCEEDED for a day that ran under the wrong clock, a
`Payment` row saying *cheque at the counter* for money that came off a card, a
stall sweep that can never flag twice. Documents you would rather not hold in
front of a judge.

## Binding for every row in this arc

The review's **"do not build"** list, now three arcs deep and repeated in the
Milestone 14 header and D-201:

- No accrual or interest engine before a second state is onboarded (R-183's
  posture; R-200/finding 14 takes the same one).
- No Stripe Connect. Still a legal-structure decision nobody has taken.
- No settings screen for `CHASE_LADDER_DAYS`, `TURN_STAGE_DAYS`,
  `TURN_STALL_DAYS`, `PLAN_GRACE_DAYS` or the stall thresholds.
- **No second queue.** D-9 has been paid for three times. R-188, R-195 and
  R-197 all want the *existing* Task queue reachable and correctly dated.
- **No backfill of anything** — D-169's doubled `Payment` rows, R-038a's
  no-ledger payments, and now any plan R-187 finds completed wrongly.
- No per-stage turn table, no second definition of "days vacant".

**Two rows are Needs counsel**: R-188 (does a timely itemization with a late
refund partially defend?) and R-194 (does a partial payment cure, and does
accepting it waive — the second is already a three-valued `JurisdictionRule`
field). **R-192 records its production frequency as unknown** — code path
verified, frequency not, pending real Stripe redelivery behaviour.

**Thirteen of the fifteen rows are inherited evidence.** Only findings 1 and 5
were spot-checked in the planning session. R-150's rule stands: re-verify the
file and line before building, and if the claim is wrong, say so in the entry
rather than building around it.

## Still true from earlier handoffs

- **Rows 81 (R-081), 97 (R-097) and 155 (R-168) are SPLIT-PARENT
  placeholders.** Every child shipped. Ticking them is bookkeeping.
- **Row 93 (R-093) is externally blocked** — real vendor drivers, each needing
  a signed commercial relationship. Not a laptop item.
- **`e2e/leases.spec.ts`'s cleanup flake now has a row** — 189 / R-202, at the
  end of the arc. It costs CI time on every push, so pull it forward if a
  sweep goes red on `WorkOrder_unitId_fkey` rather than treating it as new.

## Standing traps worth re-reading before any UI work

**Run `--project=mobile-chrome` as well as `desktop-chrome`** whenever a change
touches a form control or page layout (D-194), and whenever a page renders a
user-supplied VALUE (D-197) — the second kind hides from an element-by-element
probe; only `document.documentElement.scrollWidth` sees it.

**Use `npm run test:e2e`, never bare `npx playwright test`.** The latter gives
28 failures in 0–222ms with no `DATABASE_URL`, which reads exactly like the
jetsam symptom CLAUDE.md warns about and is not it.

**Prove a new assertion against the reverted fix** (D-197). An assertion that
still passes with the fix removed is worth nothing, and for a unit test it is
one `perl -0pi -e` and 600ms.

**A seed defect is only visible on a walk** (D-28). R-186's two were invisible
to every test in the repo.

## Leftovers still owned by nobody

Arc 4 promoted the sharpest of these into rows — the guarantor's unreachable
channels (R-196), the dead-end Task subjects (R-195), `/jobs` being owner-only
(R-197), the unrecorded inter-entity transfer (R-198), the payment plan as
evidence (R-199), `noticePeriodCheck`/`renewalCheck`'s calendar days (R-200).
What is left unowned:

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
