# Next session

## Pick up: R-180

`docs/prds/06-backlog.md`, row 167 — the next unticked one. Read its row and
its named review finding before starting.

Model: recommend at the start of the item, per the global convention.

## Context from R-179 (done, 838c043 + 0b4677c)

R-179's first CI run **failed** and `0b4677c` fixed it: `golden-path-5.spec.ts`
carried an assertion on the chase's notice copy, and the local gate had picked
its specs from the modules touched rather than by grepping for the changed
string. Run `34238610315` is green on every job. **When a user-visible string
changes, `grep -rn "<the old string>" e2e` is the spec list.**

**D-188 to D-190.** The chase reaches everybody and runs itself.

- **`sendReminders` sends PER PERSON, not per lease.** The idempotency key is
  `reminder:<template>:<lease>:<TENANT|GUARANTOR>:<id>:<local day>`. Any
  fixture counting notification rows off a chase gets one set per active
  tenant plus one per active guarantor.
- **`{{tenant.first_name}}` resolves to the RECIPIENT.** A guarantor is
  greeted by their own name. The catalogue field names did not change.
- **Every guarantor SMS is suppressed as `no_consent`, deliberately** (D-190).
  `TenantConsent` is keyed on `tenantId` and there is nowhere to record a
  guarantor's agreement. The email is the delivery that lands.
- **`payments.chase` runs at 08:00 property-local and raises a Task, never
  sends** (D-189). `CHASE_LADDER_DAYS = [1, 5, 15]`, counted from the END of
  grace and matched exactly — a `>=` there is a queue nobody can clear.
- **`rentRoll()` now takes `Pick<ResolvedScope, 'propertyIds'>`** and carries
  `graceDays`. That narrowing is what lets a job reuse it; do not re-derive
  grace, the R-118 anchor, holds or plans anywhere else.

Left behind, owned by no item:

- A guarantor gets a PORTAL-channel chase and the guarantor portal has no
  inbox to read it in.
- Guarantor consent cannot be recorded at all, so D-190's suppression is
  permanent rather than closeable.
- `CHASE_LADDER_DAYS` is a house heuristic in code with nowhere to configure
  it — same gap as `TURN_STAGE_DAYS`.
- The `rent.chase` Task links to nothing, like R-158's five and R-178's sixth.
- Nothing chases a non-tenant `LeasePayer` — a housing authority behind on its
  portion (D-13) is invisible to the ladder.
- **`e2e/leases.spec.ts` flakes on its own cleanup**: `unit.deleteMany` refuses
  on `WorkOrder_unitId_fkey` because R-178's lease-end opens six work orders
  and the delete is ordered against the test body rather than the async
  writer. Went red once in R-179's run, green on retry. It will keep flaking
  CI.
- **The merge-field catalogue prints raw `YYYY-MM-DD`** — `lease.starts_on`,
  `lease.ends_on`, `balance.due_on` and `today` all fill with an ISO string, so
  any operator template using one has been mailing tenants "due on 2026-09-01".
  The D-153 defect in the one place D-154's grep predicate cannot see it.

Still unowned from R-178: no `cases.stalled` Task links to its subject (all six
types); a turn that stalls, resumes and stalls again is flagged once;
`TURN_STAGE_DAYS` has nowhere to configure it; `draftPunchListFromInspection`
findings are still unstaged.

Still unowned from R-176: nothing warns portfolio-wide that a unit was listed
with an open re-key; a CANCELED re-key reads identically to one that never
happened; nothing backfills units turned before 2026-09-07.

Still unowned from R-177: the R-032c "was this fixed?" SMS default and the
TCPA question are both owner decisions, recorded and unfixed. Email-intake
tickets get no clarify link; no staff "ask them again" button;
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

**Check `gh run list --limit 5`** rather than assuming. R-179's own runs are
there: `34236161652` red, `34238610315` green.
