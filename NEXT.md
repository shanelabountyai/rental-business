# Next session

## Pick up: R-179

`docs/prds/06-backlog.md`, row 166 — the next unticked one. Read its row and
its named review finding before starting.

Model: recommend at the start of the item, per the global convention.

## Context from R-178 (done, 5f83e44)

**D-184 to D-187.** The turn is a sequenced project now.

- **The plan is DERIVED, not stored.** `planTurn` in
  `packages/core/turnover/schedule.ts` computes everything from the move-out
  date, `targetRentReadyDate` and the turn's own work orders. There is no
  per-stage table and **this item added no migration**. If you are tempted to
  store a per-stage date, read D-184 first — moving the target is the
  commonest edit on that panel and a stored date goes stale against it.
- **`startTurnoverProjectForLease` now opens SIX work orders, not one.** Any
  fixture that counts work orders on a turn created through that function
  gets `TURN_SEQUENCE.length`. Specs that seed `turnoverProject.create`
  directly (punch-list, queries, the first turnover e2e test) are unaffected.
- **`WORK_PERFORMED_STATUSES` is the one definition of "the physical work
  happened"** — core, three readers. Do not re-derive it, and do not confuse
  it with `OPEN_WORK_ORDER_STATUSES`, which counts WORK_COMPLETE and VERIFIED
  as open because the vendor is still owed money.
- **The re-key waits on nothing** (D-187). If you add a sequencing rule, keep
  the exemption or the panel contradicts R-176's URGENT work order.

Left behind, owned by no item:

- No `cases.stalled` Task links to its subject — all six types, not just the
  new one. R-158 shipped five without links.
- A turn that stalls, resumes and stalls again is flagged once. Shared by
  every R-158 type; fixing it changes all six.
- `TURN_STAGE_DAYS` is a house heuristic in code with nowhere to configure it.
- `draftPunchListFromInspection` findings are still unstaged, and now land
  beside six template lines.

Still unowned from R-176: nothing warns portfolio-wide that a unit was listed
with an open re-key — `markTurnoverRentReady` warns once and the stall sweep
only looks at turns with `rentReadyAt: null`, so after the override nothing
looks again. A CANCELED re-key still reads identically to one that never
happened; nothing backfills units turned before 2026-09-07.

Still unowned from R-177: the R-032c "was this fixed?" SMS default and the
TCPA question are both **owner decisions**, recorded and unfixed. Email-intake
tickets get no clarify link; no staff "ask them again" button; a clarification
raises nothing for a PM who already triaged;
`e2e/maintenance-phone-log.spec.ts` cleans up by collected-id list.

Still unowned from R-175: no e-sign on a payment plan agreement; no
tenant-facing view of the schedule.

Still unowned from R-174: a manager holding a `job_failed` task cannot open
`/jobs` to act on it; `overdueToday` renders every affected property name
inline; nothing tests `jobHealth()` directly.

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

**Check `gh run list --limit 5`** rather than assuming — R-178's own run is
the one to read.
