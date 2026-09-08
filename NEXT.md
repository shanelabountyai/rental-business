# Next session

## Pick up: R-183

`docs/prds/06-backlog.md`, row 170 — the next unticked one. Read its row and
its named review finding before starting.

Model: recommend at the start of the item, per the global convention.

## Context from R-182 (done, b96e80c + 0fc2898)

**CI run for R-182 was still in flight when the session closed.** Check it
(`gh run list --limit 5`) before assuming green. R-181's run (34252431016) was
green — checked, not copied forward.

**D-193.** A jurisdiction can now say how it counts to thirty.

- **ONE three-valued enum, not the backlog row's enum-plus-boolean pair.**
  `BUSINESS` + roll-forward is meaningless (a business-day count always lands
  on a business day), and a representable-but-meaningless combination
  eventually gets filled in.
- **Null `dayCountBasis` = unreviewed, and READS AS CALENDAR.** The migration
  deliberately does not backfill: a `CALENDAR` default writes a legal claim
  onto every row. Reading null as calendar is exactly the pre-R-182 behaviour,
  so no running deadline moved (D-12).
- **Holidays are a `String[]` ON THE RULE ROW**, not a table. `rulesFor`
  already hands every clock the whole row, so no call site needed a second
  fetch. Next year's dates mean a new rule version — that is D-4's own shape.
- **`addBusinessDays` survives and is NOT renamed.** Still right for report
  ranges, turn-stage targets, showing calendars. `plan.ts`'s
  `PLAN_GRACE_DAYS` stays on it deliberately — it is mail float, not statute.
  SCRA's 30 days stays too: federal (D-82), not state config.
- **`dayCount` is required at every call site, never defaulted.** A default is
  this product deciding how a state counts, which is the defect.
- **A Prisma `String[]` needs `@default([])` in the SCHEMA, not just a SQL
  `DEFAULT`.** SQL-only is permanent `migrate diff` drift; schema-only breaks
  every existing `create`. `npm run db:ci` caught it.

Left behind, owned by no item:

- `noticePeriodCheck` (LEASE-12) and `renewalCheck` (LEASE-09) still count
  calendar days whatever the basis says — they subtract two `Date`s. Fixing
  them means `Date` → `BusinessDate`, which is R-042's bug class. The coverage
  screen names both as a `productLimits` line on any non-calendar state.
- `assessEvidence`'s abandonment presumption period is a plain elapsed count
  and takes no basis; not covered by that warning either.
- A business-day state with no holidays on file skips only weekends. Not
  refused on write; coverage says so as a second `productLimits` line.
- Nothing seeds a holiday list for any state — a counsel question, and Texas
  is CALENDAR and never reads it.

Still unowned from R-181: a texted-in tenant never gets the quotable
reference; the acknowledgement rides the hourly outbox cron so it can lag an
hour; `entry.notice` names no ticket; no e2e walks intake → acknowledgement.

Still unowned from R-180: nothing records the inter-entity transfer; no
processing fee anywhere, so no net payout can be stated; `HAP_ACH` would be
counted as a Stripe settlement if anything wrote it; no `stripePayoutId`.
**Stripe Connect is the real answer** and is explicitly not built — it needs a
legal-structure decision marked *needs counsel*.

Still unowned from R-179: a guarantor gets a PORTAL chase with no portal inbox;
guarantor consent cannot be recorded, so D-190's SMS suppression is permanent;
`CHASE_LADDER_DAYS` has nowhere to configure it; the `rent.chase` Task links to
nothing. **`e2e/leases.spec.ts` still flakes on its own cleanup** —
`unit.deleteMany` refuses on `WorkOrder_unitId_fkey` because R-178's lease-end
opens six work orders and the delete races the async writer. It will keep
flaking CI. **The merge-field catalogue still prints raw `YYYY-MM-DD`** —
`lease.starts_on`, `lease.ends_on`, `balance.due_on`, `today`.

Still unowned from R-178: no `cases.stalled` Task links to its subject; a turn
that stalls, resumes and stalls again is flagged once; `TURN_STAGE_DAYS` has
nowhere to configure it; `draftPunchListFromInspection` findings are unstaged.

Still unowned from R-177: the R-032c "was this fixed?" SMS default and the
TCPA question are owner decisions, recorded and unfixed. Email-intake tickets
get no clarify link; no staff "ask them again" button;
`e2e/maintenance-phone-log.spec.ts` cleans up by collected-id list.

Still unowned from R-176: nothing warns portfolio-wide that a unit was listed
with an open re-key; a CANCELED re-key reads like one that never happened.

Still unowned from R-175: no e-sign on a payment plan agreement; no
tenant-facing view of the schedule.

Still unowned from R-174: a manager holding a `job_failed` task cannot open
`/jobs` to act on it; nothing tests `jobHealth()` directly.

Still unowned from R-173: a tenant with a phone but no email still gets a live
PORTAL row and cannot sign in.

Still unowned from R-172: no staff field for a real handover date on an
inherited tenancy; `apps/web/lib/turnover/queries.test.ts` cleans up by
collected-id list.

Still unowned from R-171: `writePayment` dedups only on
`stripePaymentIntentId`, so an ACH payment may write both a `PENDING` and a
`SETTLED` row. Recorded as **unknown** — verify against real Stripe.

Still unowned from R-170a: `/staff/new` and `/staff/[id]` each take ~21s to
axe-scan against `/staff`'s 2.2s.
