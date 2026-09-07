# Next session

## Pick up: R-176

`docs/prds/06-backlog.md`, the next unticked row after 162. Read its row and
its named review finding before starting.

Model: recommend at the start of the item, per the global convention.

## Context from R-175 (done, 53cc52a)

A repayment plan is now a schedule, not a hold reason. **D-181** records the
four rules. Two are easy to break by accident:

- **The break test is cumulative** — total paid since the plan started against
  the cumulative instalment total matured today. New rent charged during the
  plan cancels out algebraically; per-instalment matching would be wrong, not
  merely more work.
- **A REVERSAL is classified by its SIGN.** Positive = undoing a payment
  (a returned cheque), negative = undoing a charge. `paidTowardPlan` in
  `apps/web/lib/payments/plans.ts` depends on it.
- `placeLeaseHold` REFUSES `payment_plan`. The hold comes from the plan.
- `LeaseHold.liftedBySystem` is new: R-084's check constraint now requires
  exactly one of that and `liftedByStaffId` on a lifted row.

Left behind, owned by no item:

- No signed document / e-sign on a payment plan agreement.
- No tenant-facing view of the schedule — the tenant learns the dates only
  from whatever message a person sends.

Still unowned from R-174: a manager holding a `job_failed` task cannot open
`/jobs` to act on it (`job.manage` is owner-only); `overdueToday` renders
every affected property name inline; nothing tests `jobHealth()` directly.

Still unowned from R-173: a tenant with a phone but no email still gets a live
PORTAL row and cannot sign in; nothing links a `serve_notice_offline` task to
a `Notice` row.

Still unowned from R-172: no staff field to type a real handover date for an
inherited tenancy whose move-in walk never happened;
`apps/web/lib/turnover/queries.test.ts` cleans up by collected-id list.

Still unowned from R-171: `writePayment` dedups only on
`stripePaymentIntentId`, so an ACH payment may write both a `PENDING` and a
`SETTLED` row. Recorded as **unknown** — verify against real Stripe.

Still unowned from R-170a: `/staff/new` and `/staff/[id]` each take ~21s to
axe-scan against `/staff`'s 2.2s.

**Check `gh run list --limit 5`** rather than assuming — R-175's own run is
the one to read.
