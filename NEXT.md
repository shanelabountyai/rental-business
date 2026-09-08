# Next session

## Pick up: R-182

`docs/prds/06-backlog.md`, row 169 — the next unticked one. Read its row and
its named review finding before starting.

Model: recommend at the start of the item, per the global convention.

## Context from R-181 (done, 1d4f6af + 1abe84b)

**CI run for R-181 was still in flight when the session closed.** Check it
(`gh run list --limit 5`) before assuming green.

**D-192.** A tenant who reports a maintenance problem now hears back.

- **`maintenance_ack` is its own category, and that was the whole item.**
  `maintenance_update` defaults OFF on SMS. Folding a receipt into it ships
  the feature inert for the phone-only tenant. Fifth entry in the
  `defaultEnabled` carve-out list after R-058/059/064/177.
- **All five ticket-creation sites already emit `ticket.created`**, so one
  outbox consumer covers every intake path. Do not add a sixth per-site call.
- **"Does a clarify notification exist?" is a WRONG predicate.** `notify()`
  writes a `Notification` row per channel even when it SUPPRESSES, so it is
  also true for a tenant who muted the category. The SMS skip is decided on
  `Ticket.source`.
- **`scheduleEntry` (`workorders/scheduling.ts:252`) is the ONLY writer of a
  SCHEDULED work order** and already sends `entry.notice` on a locked
  category. That is why R-181 shipped no `ticket.scheduled` template.
- **Deleting an `OutboxEvent` a notification points at fails.**
  `Notification.eventId` is `ON DELETE SET NULL`; the cascade's UPDATE hits
  the append-only trigger and kills the whole delete. Deactivate the property
  instead, and leave the `EventConsumption` rows with their events.

Left behind, owned by no item:

- A texted-in tenant never gets the quotable reference, and gets nothing at
  all when `inviteToClarify` was correctly silent (no SMS consent, mint
  failure).
- The acknowledgement rides the hourly outbox cron, so it can lag by an hour.
- `entry.notice` names no ticket, so a tenant with two open requests cannot
  tell which one a scheduled visit is for. Changing it means changing legally
  significant notice text.
- No e2e walks intake → acknowledgement end to end; the consumer is proved at
  the database level only.

Still unowned from R-180: nothing records the inter-entity transfer itself;
no processing fee anywhere, so no net payout can ever be stated; `HAP_ACH`
would be counted as a Stripe settlement if anything ever wrote it; no
`stripePayoutId` and no per-payout grouping. **Stripe Connect (a connected
account per entity) is the real answer** and is explicitly not built — it
needs a legal-structure decision marked *needs counsel*.

Still unowned from R-179: a guarantor gets a PORTAL chase with no portal inbox
to read it in; guarantor consent cannot be recorded at all, so D-190's SMS
suppression is permanent; `CHASE_LADDER_DAYS` has nowhere to configure it; the
`rent.chase` Task links to nothing; nothing chases a non-tenant `LeasePayer`.
**`e2e/leases.spec.ts` still flakes on its own cleanup** — `unit.deleteMany`
refuses on `WorkOrder_unitId_fkey` because R-178's lease-end opens six work
orders and the delete races the async writer. It will keep flaking CI.
**The merge-field catalogue still prints raw `YYYY-MM-DD`** — `lease.starts_on`,
`lease.ends_on`, `balance.due_on` and `today`. The D-153 defect where D-154's
grep predicate cannot see it.

Still unowned from R-178: no `cases.stalled` Task links to its subject; a turn
that stalls, resumes and stalls again is flagged once; `TURN_STAGE_DAYS` has
nowhere to configure it; `draftPunchListFromInspection` findings are unstaged.

Still unowned from R-176: nothing warns portfolio-wide that a unit was listed
with an open re-key; a CANCELED re-key reads like one that never happened;
nothing backfills units turned before 2026-09-07.

Still unowned from R-177: the R-032c "was this fixed?" SMS default and the
TCPA question are owner decisions, recorded and unfixed. Email-intake tickets
get no clarify link; no staff "ask them again" button;
`e2e/maintenance-phone-log.spec.ts` cleans up by collected-id list.

Still unowned from R-175: no e-sign on a payment plan agreement; no
tenant-facing view of the schedule.

Still unowned from R-174: a manager holding a `job_failed` task cannot open
`/jobs` to act on it; `overdueToday` renders every affected property inline;
nothing tests `jobHealth()` directly.

Still unowned from R-173: a tenant with a phone but no email still gets a live
PORTAL row and cannot sign in; nothing links a `serve_notice_offline` task to
a `Notice` row.

Still unowned from R-172: no staff field for a real handover date on an
inherited tenancy whose move-in walk never happened;
`apps/web/lib/turnover/queries.test.ts` cleans up by collected-id list.

Still unowned from R-171: `writePayment` dedups only on
`stripePaymentIntentId`, so an ACH payment may write both a `PENDING` and a
`SETTLED` row. Recorded as **unknown** — verify against real Stripe.

Still unowned from R-170a: `/staff/new` and `/staff/[id]` each take ~21s to
axe-scan against `/staff`'s 2.2s.
