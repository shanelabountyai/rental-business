# Next session

## Pick up: R-178

`docs/prds/06-backlog.md`, row 165 — the next unticked one. Read its row and
its named review finding (§10) before starting. It depends on R-176 (done) and
R-158.

Model: recommend at the start of the item, per the global convention.

## Context from R-177 (done, ad6bdeb)

**D-183.** The seven troubleshooting scripts now reach SMS and the phone call,
not just the portal wizard.

- **There is ONE wizard, not two.** `MaintenanceWizard` takes `submit`,
  `formAction`, `uploadPhoto` and `doneHref` as optional props; the portal's
  defaults are unchanged and `/clarify/[token]` injects token-bound actions.
  If you add a step, both doors get it — that is the point.
- **`/clarify/[token]` is the fourth token-scoped page** (after vendor, verify,
  pay). No session. It refuses once a work order exists, appends to the
  description rather than replacing it, and never overwrites a category a PM
  set during triage.
- **The phone form now enforces the script.** `PhoneLoggedRequestInput` extends
  `MaintenanceRequestInput`; `scriptViolations` is one gate for all three doors.
  Any new fixture for a phone-logged request needs `promptAnswers` and
  `troubleshooting`, with REAL option strings — a select answer outside its own
  options is refused.

**Two things needing YOUR decision, both recorded and neither fixed:**

- **R-032c's "was this fixed?" SMS has never been sent by SMS by default.**
  `defaultEnabled('maintenance_update', 'SMS')` is false, and that template is
  on `maintenance_update`. Its own comment says "the reply rate IS the
  feature". One line in `packages/core/notifications/categories.ts` fixes it,
  but it changes when tenants get texted — your call, not a build decision.
  R-177 carved its own `maintenance_clarify` category rather than change it.
- **Whether an inbound text is itself TCPA consent to reply.** Today a tenant
  with no `TenantConsent` SMS row gets the clarify invitation in the portal
  only — the one place that persona never looks.

Left behind, owned by no item:

- Email-intake tickets (R-097f) get no clarify link. `inviteToClarify` takes
  only a ticket id, so it is a one-line call somebody has to decide to add.
- No staff "ask them again" button, though `issueClarifyLink` already
  revokes-then-creates for exactly that.
- A clarification raises nothing for a PM who already triaged.
- `e2e/maintenance-phone-log.spec.ts` still cleans up by collected-id list.

Still unowned from R-176: nothing warns portfolio-wide that a unit is listed
with an open re-key (**R-178 is where that becomes visible**); a CANCELED
re-key reads identically to one that never happened; nothing backfills units
turned before 2026-09-07.

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

**Check `gh run list --limit 5`** rather than assuming — R-177's own run
(`34156327059`) is the one to read.
