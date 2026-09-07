# Next session

## Pick up: R-177

`docs/prds/06-backlog.md`, row 164 — the next unticked one. Read its row and
its named review finding before starting.

Model: recommend at the start of the item, per the global convention.

## Context from R-176 (done, ed88d0e)

**D-182.** A move-out now retires the unit's `AccessCode` rows and the turn
opens a re-key. Three things are easy to get wrong later:

- **The retire is INSIDE the tenancy-ending transaction**, unlike every
  best-effort sibling around it. A stale code cannot be caught up by a
  re-run, because nothing knows to ask.
- **Retiring changes no lock.** `effectiveTo` closes our record; the URGENT
  `REKEY` work order is the half that changes the door.
- **"Re-key done" is NOT `OPEN_WORK_ORDER_STATUSES`.** VERIFIED counts here —
  a locksmith who has not been paid has still changed the lock.

Any test that deletes a unit now has to delete its work orders and access
codes first. Three cleanups were fixed for this; a fourth will surface.

Left behind, owned by no item:

- Nothing warns on `/leases`, the dashboard or the listing flow that a unit
  is listed with an open re-key — only the rent-ready press warns. **R-178
  (row 165) already depends on R-176** and is where a stalled stage becomes
  visible portfolio-wide.
- A CANCELED re-key reads identically to one that never happened, so an
  operator with no keypads is warned on every turn with no way to say so once.
- Nothing backfills units turned before today.

Still unowned from R-175: no e-sign on a payment plan agreement; no
tenant-facing view of the schedule.

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

**Check `gh run list --limit 5`** rather than assuming — R-176's own run is
the one to read.
