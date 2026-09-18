# Operator review — 2026-09-17

This review sources the Arc 6 backlog rows, following the precedent of D-164,
D-172, D-201 and D-222. The rental-operator agent wrote it after R-221 closed
the Arc 5 backlog (rows 192–208, all ✅). It has thirteen findings, ranked by
operational pain × frequency. Ten describe behaviour that is **wrong**, not
missing, and those ten come first. Category key: **(a)** gap in what shipped ·
**(b)** new capability · **(c)** recorded debt now load-bearing.

Four notes that are not findings:

- **CI.** It was green when this review was commissioned. The coordinator read
  R-221's run `35267263178` as `completed success` on `209d0b4`. This review
  did not re-read it.
- **Arc 5 fixed all fifteen of the last review's findings at the writer.** Most
  of its items proved their new assertion against the reverted fix (D-197),
  though R-212 did not. The defects below are therefore in places the last
  four reviews did not look. **Six of the thirteen are leftovers that an Arc 5
  `PROGRESS.md` entry recorded as "owned by nobody" and that have since become
  load-bearing.** That count is the argument for reading "what it left behind"
  as a queue, not a diary.
- **Two code comments claim a behaviour the code does not have.**
  - `move-in-consumer.ts` says that *"the successor's deposit case reads the
    PREDECESSOR's move-in report"* (finding 5).
  - `triage-consumer.ts` says that *"a genuine emergency never arrives this
    way at all"* (finding 2).

  Both comments are confident, and both are wrong in a way that costs money.
  Treat a comment's claim about another module as a candidate, not a fact.
  This is the same rule D-154 applies to a field name.
- **`NEXT.md` leftovers I judge deliberate and would leave alone:**
  - No demo `REVERSAL` rows (D-238: the seed holds to states the product
    produces).
  - No backfill or re-report of archived accrual exports (D-201/D-222).
  - `/reports/operating` verified by SQL rather than in a browser, and the
    deposit-slip, abandonment, claims, confidential and guarantor-portal demo
    gaps. All of these belong to Arc 6's own D-28 walk.
  - The flaky `audit-store.test.ts` ordering test. It is real, but it is suite
    hygiene, not operator pain.

  **One `NEXT.md` leftover is real and is finding 13:** packet photographs are
  listed but not embedded.

## Verdict

The shape is right. A new operator could run a 30-door portfolio on this
product, and on the evidence trail it would beat most software they could buy.
Arc 5 put the money numbers on the right base, and the arithmetic in
`aging.ts`, `late-fees.ts` and `tax/queries.ts` is now careful in a way that
survives an audit.

**Arc 5's defect class was readers computing off the wrong base. Arc 6's class
is two automated processes that each work alone and disagree about the same
tenancy.** Each process is correct, tested and documented on its own terms.
The damage happens where two of them meet the same lease on the same morning:

- a 03:00 job decides a house is vacant, and a 04:00 job decides the same
  tenant is staying month to month;
- a notice hold switches the late-fee meter off, and nothing switches it back
  on;
- the counter demands the full balance, and the one-invoice lookup refuses
  anything bigger than one month;
- a renewal starts a new `Lease` row, and every evidence reader looks for the
  move-in report under the new id only;
- the entry gate judges a notice as served now, and the notice writer then
  records that it was not served.

Nothing in the suite drives two of these together. That is why every one of
them is green.

**The single most consequential gap is finding 1.** When a fixed-term lease
lapses with no renewal and no notice (the ordinary case, and the one R-065
automated), `unit.auto_make_ready` runs at 03:00, before `lease.mtm_rollover`
runs at 04:00. It marks the occupied house `MAKE_READY`, stamps a move-out
that never happened, retires the family's door codes, and opens a six-stage
turn including a re-key. Then the rollover keeps billing them. It fires on
every lease that rolls to month-to-month, for the life of the portfolio.

## Findings

### 1. WRONG — The morning a lease rolls to month-to-month, the 03:00 job marks the occupied house vacant, retires the tenant's door codes and opens a turn; the 04:00 job keeps billing them · (a) · M · PROP-02/LEASE-09/LEASE-12, R-009/R-065/R-176/R-178, D-178/D-182/D-184

**The two jobs select the same lease on the same morning:**

- `unit.auto_make_ready` runs at `LOCAL_HOUR = 3`
  (`apps/web/lib/units/auto-make-ready.ts:37`). It selects
  `status IN ('ACTIVE','MONTH_TO_MONTH'), endsOn < today, unit OCCUPIED`
  (`:58-64`) and checks only for a successor lease (`:70-79`).
- `lease.mtm_rollover` runs at `LOCAL_HOUR = 4`
  (`apps/web/lib/leases/renewal-rollover-job.ts:28`). It selects the same
  `status: 'ACTIVE', endsOn < today` lease with `noticeGivenAt: null` (`:46`),
  sets it to `MONTH_TO_MONTH`, sets `endsOn: null` (`:79-91`), and calls
  `syncLease`.

Neither job knows the other exists, and no test drives both jobs against one
lease (`grep mtm_rollover apps/web/lib/units` returns nothing).

**What happens to a tenant whose lease simply ran out.** At 03:00:

- The unit flips to `MAKE_READY` (`:86-89`).
- `Lease.moveOutAt` is stamped with the contractual end date (`:97-102`). That
  is a move-out that never happened, written onto a tenancy that is about to
  continue.
- `retireUnitAccessCodes` ends every live `AccessCode` on the unit (`:129`,
  `apps/web/lib/locks/access-codes.ts:29-32`).
- `startTurnoverProjectForLease` opens R-178's templated work orders, the
  re-key stage among them (`:147`).
- `unit.became_make_ready` emails every staff member with `unit.write`.

At 04:00 the lease becomes month-to-month and Stripe keeps billing. The unit
never returns to `OCCUPIED`, because nothing writes that back.

**The damage:**

- **The lockout.** A re-key work order is opened on an occupied home, and the
  product's own record says the family's codes are dead. Nothing touches a
  physical lock until somebody acts on that work order, and D-182 says so. But
  it is a Task in the queue telling a vendor to change the locks on a house
  somebody lives in.
- **Wrong numbers on every report that reads unit status.** The house is
  counted as vacancy loss on the rent roll (`rent-roll.ts:147-153`) while it
  is also billed. `daysOnMarket` counts from the fake `moveOutAt`. R-167's
  economic occupancy and R-172's days-vacant clock both report the house as
  empty for as long as the tenant stays.
- **The evidence record is corrupted.** A `moveOutAt` on a live tenancy is a
  false fact in the record that deposit and holdover arguments are made from.

**The holdover case is worse.** A lease under notice is excluded from the
rollover by `noticeGivenAt: null`, but not from `auto_make_ready`. So a tenant
who gave notice and then did not leave, or who was non-renewed and will not
leave, has their codes retired and a re-key opened the morning after the term
ends. That is **self-help eviction** as the record reads it. **Needs counsel**
on the lockout exposure. The engineering does not need counsel: nothing may
treat a lease as over while its status says it is not.

**Money:**

- Take 30 doors on annual leases, with a third lapsing to month-to-month each
  year. That is about ten false turns a year: ten sets of turn work orders to
  cancel by hand, and ten occupied houses reported vacant.
- At $1,500 rent each is $49/day of phantom vacancy loss, so ten of them
  running 60 days before somebody notices is about **$29,000 of vacancy loss
  that does not exist**.
- One re-key actually executed on an occupied house is a locksmith bill plus a
  lockout claim.

**Fix:** `auto_make_ready` must exclude any lease the rollover will keep, and
any lease under notice whose `moveOutAt` is null. Only a recorded move-out, or
an ended status, may make a unit ready. Add one test that runs both jobs
against the same lease on the same business date.

### 2. WRONG — An emergency that arrives by text, email or phone can never page anybody, and staff cannot mark it as one · (a) · S–M · MAINT-01/NOTIF-05/MAINT-03, R-020/R-021/R-029/R-097f/R-207, D-18

**Only the tenant can make a ticket an emergency.** `priority: 'EMERGENCY'` on
a ticket has exactly one writer: `submitEmergency`
(`apps/web/lib/maintenance/actions.ts:417`), which is reachable only from the
signed-in portal page `app/portal/(signed-in)/maintenance/emergency/page.tsx`.

**The other three intake doors top out at URGENT:**

- SMS (`comms/sms-intake.ts:169-173`), email and phone-logged intake take
  their priority from `suggestTicketPriority`. That function returns
  `'URGENT' | 'ROUTINE'` and nothing else
  (`packages/core/maintenance/priority.ts:35-40`).
- The staff triage override offers `TRIAGE_PRIORITY_OPTIONS = ['URGENT',
  'ROUTINE']` (`maintenance/actions.ts:683`, enforced at `:735`), and the
  select in `components/maintenance/triage-panel.tsx:159-165` shows only those
  two. **A PM reading "sewage coming up through the tub" at 23:10 has no
  control that makes it an emergency.**

**Everything downstream keys on `EMERGENCY`, so none of it fires:**

- **The initial page.** `emergencyPagingPlan` is called only from the portal
  path (`actions.ts:474`).
- **The 15-minute escalation.** `unacknowledgedEmergencies` filters on
  `priority: 'EMERGENCY'` (`maintenance/emergency.ts:154`).
- **The shutoff-valve instructions.** They render only on the portal page.
- **R-207's quiet-hours bypass on the vendor dispatch.** It reads
  `workOrder.priority === 'EMERGENCY'` (`workorders/actions.ts:443`), and a
  work order raised from an SMS ticket inherits URGENT.

**The comment that hid this** is at `triage-consumer.ts:19-22`: *"A genuine
emergency never arrives this way at all — R-020's own intake pages on-call
directly."* It does arrive this way, from the tenant this product keeps
saying it is for: the long-term renter who will never log in and texts at
night. Their emergency becomes an URGENT triage Task delivered by the
**hourly** outbox (`triage-consumer.ts:16-19`), and nobody's phone rings.

**Money:**

- A supply line or sewage backup sitting overnight rather than for an hour is
  the difference between a plumber call and a mould remediation plus an
  insurance deductible. That is $4,000–$25,000 per event, the same figure the
  last review put on R-207's defect, which this one reopens by a different
  door.
- Habitability exposure runs on top of that (R-217's clock is already
  running, from the ticket's `createdAt`).

**Fix:**

- Add `EMERGENCY` to the staff triage options. Setting it runs the same
  paging-plan and dispatch path the portal submit runs, and records who
  escalated and when.
- When SMS, email or phone intake detects habitability language, page the
  on-call rota in the same request with the tenant's own words attached,
  rather than waiting for the outbox. That is suggested emergency, not
  asserted emergency, and a human confirms it.
- Reply to the tenant's text with the shutoff instruction when the unit
  record has one.

### 3. WRONG — On real Stripe a tenant cannot cure at the counter: the cheque is refused if it covers more than one month, and refused if it does not cover everything · (a)(c) · M · PAY-05/PAY-12/PAY-14/INSP-05, R-038/R-038a/R-155/R-156/R-209/R-215, D-26/D-31/D-142

**The lookup returns at most one open invoice.** The live adapter's
`getOpenInvoice` asks Stripe for
`/invoices?subscription=…&status=open&limit=1`
(`apps/web/lib/billing/stripe-adapter.ts:668-672`).

**The counter compares the cheque against that one invoice.**
`recordOfflinePayment` reads it (`payments/offline.ts:141`), and
`offlinePaymentDecision` refuses `more_than_invoiced` whenever the amount
exceeds it (`packages/core/payments/offline.ts:188-190`). Three lines later it
refuses `partial_blocked` whenever `blockPartial` is set and the amount is less
than the **whole balance** (`:205-207`). Its own comment says so: *"a tenancy
two periods behind can settle one invoice in full while still owing."*

**Worked example.** A tenant is two months behind at $1,500. The operator has
served a pay-or-quit and ticked "part payments blocked", as R-156's
serve-and-hold offers. The tenant brings a $3,000 money order. The counter
refuses it (`more_than_invoiced`, because the one invoice is $1,500). A
$1,500 money order is refused too (`partial_blocked`). **No amount the tenant
can bring is accepted.** A refused lawful cure tender is the tenant's defence
in the eviction it was served for, and a restart from zero for the operator.
**Needs counsel** on the tender. The arithmetic does not need counsel.

**Why no test has ever seen this.** The simulator's `getOpenInvoice` reports
the whole lease balance as one synthetic invoice
(`billing/simulated-adapter.ts:373`, and R-209's own note), so the refusal
cannot happen in any test or demo. That is D-27's warning in a new place: a
simulator that agrees with us by construction.

**The same root has two recorded instances, both "owned by nobody":**

- **R-209 (deposit applied to arrears).** `deposits/actions.ts:331-349`
  refuses when the arrears span more than one invoice.
- **R-215 (damages invoice).** A one-off damages invoice has no subscription,
  so the `subscription=` filter never finds it, and a cheque toward it cannot
  be recorded.

D-26 keeps the live driver in test mode, so none of this costs money today.
All three sites become live the day it goes live, and all three bite exactly
on the tenancies that matter most: the ones more than a month behind.

**Fix:** list open invoices by customer, not by subscription and not
`limit=1`. Apply an offline payment across invoices oldest-first in the
allocation order core already computes (`ledger/allocate.ts`). Make the
simulator return one invoice per billed period, so the multi-invoice branch is
reachable in a test at all.

### 4. WRONG — A rent increase typed on the lease form reaches Stripe on the next cycle with no notice period, no cap check and no notice document · (a) · S–M · LEASE-09/PRD §6.7, R-033/R-055/R-065/R-200, D-4/D-12/D-56

**The edit form checks one thing.** `updateLease`
(`apps/web/lib/leases/actions.ts:341-372`) runs the retaliation gate on a
raise. It then writes `rentCents` and calls `syncLease` whenever the rent
moved (`:408-416`), which pushes the new price to the subscription at once.

**The jurisdiction rule's rent-increase columns are never read on this
path.** `JurisdictionRule.rentIncreaseNoticeDays` and
`rentIncreaseCapPercentBps` both exist
(`packages/db/prisma/schema.prisma`, model `JurisdictionRule`). They have
exactly one reader: `renewal-check.ts:39` → `renewalCheck`
(`packages/core/leases/renewal.ts:102-139`), which only `offerRenewal` calls.

**So the careful path covers the wrong population.** The notice-period and
cap checks (R-065, made basis-aware by R-200) guard fixed-term renewals. The
only way to raise the rent on a **month-to-month** tenancy is the edit form,
and it has neither check. The MTM population is exactly the one the product
grows automatically: `lease.mtm_rollover` converts every lapsed fixed term.
Nothing produces a rent-increase notice either. No `Notice` type exists for
one, so the written notice that makes an increase effective is not in the
evidence trail at all. The rollover itself applies `mtmRentCents` with no cap
check (`renewal-rollover-job.ts:76`). That rate is arguably pre-agreed in the
lease, but it is unchecked against a state cap all the same.

**Money:**

- A $100 increase entered on the 20th for a tenant on autopay is debited on
  the 1st, with ten days' notice where the state may require far more.
- The increase is typically unenforceable until proper notice runs, so what
  was collected is refundable.
- On a tenant who later complains, it is exhibit A in a retaliation or
  unfair-practice claim.

**Needs counsel** on each state's period. That is exactly why it is already a
D-4 column.

**Fix:** a raise on the edit form carries an effective date and runs
`renewalCheck`'s cap and notice logic against it. It warns with an override
reason, as `offerRenewal` already does. It generates a rent-increase `Notice`
through R-051's machinery, and it pushes to Stripe only on the effective date,
the same deferred-cutover shape R-065 uses for renewals.

### 5. WRONG — A tenant who renewed has no move-in side to their deposit case, and the code says they do · (a)(c) · M · INSP-01/INSP-03/INSP-05/PAY-11, R-065/R-070/R-151/R-208/R-218, D-54/D-60/D-236

**A renewal is a new lease row, and the move-in report stays on the old
one.** D-54 makes every fixed-term renewal a new `Lease` row. R-208's consumer
deliberately opens no move-in report for it (`lease.origin === 'RENEWAL'`,
`apps/web/lib/inspections/move-in-consumer.ts:64`), and its comment gives the
reason: *"The successor's deposit case reads the PREDECESSOR's move-in report
… `endRenewalPredecessor` moves the Deposit rows across."*

**The deposit moves and the report does not, and nothing reads across.**
Every evidence reader queries the lease's own id:

- `itemsFromMoveIn` (`inspections/move-out-copy.ts:36-39`,
  `where: { leaseId, type: 'MOVE_IN' }`), which builds the move-out
  side-by-side;
- R-218's deposit-dispute packet (`apps/web/lib/deposits/packet.ts:144-146`,
  the same predicate).

`renewedFromLeaseId` has no reader anywhere in `inspections/`, `deposits/` or
`ledger/`. The only readers are the renewal actions and the cutover job.
R-208's own `PROGRESS.md` entry recorded exactly this. It named R-218 as *"the
item that will feel it first"* and was owned by nobody. R-218 then shipped
without it.

**What that costs.** Every tenant who renewed even once, which at this scale
is most long-term tenants and the ones holding the largest deposits, reaches
move-out with:

- a move-out walk that falls back to a blank template instead of their own
  checklist;
- a comparison with nothing on the left;
- every deduction flagged by `isUnsupportedDeduction`;
- a one-click dispute packet whose move-in exhibit is missing.

The house was photographed, room by room with the tenant's signature, three
years ago. The product simply cannot find it. On a $2,000 deposit in a state
with a penalty multiple, that is the deposit, the multiple and fees. **Needs
counsel** on the penalty only.

**Fix:** a single `baselineMoveInFor(leaseId)` that walks `renewedFromLeaseId`
to the tenancy's first lease. Read it in `itemsFromMoveIn`, in the packet, in
`deposit-clearing-job.ts`'s warning, and in `Lease.moveInAt`'s readers. Delete
or correct the comment in `move-in-consumer.ts`.

### 6. WRONG — Serving a cure notice switches late fees off for the rest of the tenancy · (a)(c) · S · PAY-04/PAY-14/RISK fair-housing, R-084/R-213, D-34/D-78/D-231

**Service places a hold with no end condition.** R-213 places a
`NOTICE_SERVED` `LeaseHold` carrying `halt_late_fees` when a cure notice is
served (`apps/web/lib/notices/actions.ts:395-419`,
`packages/core/holds/index.ts:153-165`). The late-fee job then skips every
lease holding it (`apps/web/lib/ledger/late-fees.ts:205`).

**Nothing takes the hold off.** The only code anywhere that writes `liftedAt`
lifts **payment-plan** holds (`payments/plan-actions.ts:356-359`,
`payments/payment-plan-job.ts:119-122`). A cured notice, a withdrawn one, a
dismissed case and a notice whose cure period simply ran out all leave the
meter off until somebody remembers to press "lift" on the lease page. R-213's
leftovers say so, and nobody owns it.

**What that costs.** The hold is lease-wide rather than period-wide, so a
tenant served once in March and cured in March is never charged a late fee
again for the life of the lease:

- At a $75 fee and a tenant late six months a year, that is **$450 a year per
  served tenancy**, silently.
- **The fair-housing half is worse than the money.** The portfolio is now
  enforcing its fee policy on some tenants and not on others, and the
  difference follows whoever was once served a notice.
- D-34's waiver-pattern report cannot see it, because no fee was ever
  assessed and so there is nothing to waive. The inconsistency exists and
  hides in the one report built to show inconsistency.

**Fix:** lift the `NOTICE_SERVED` hold automatically when the notice's cure
verdict is reached (R-194's cured, part-cured or not-cured) or its case
closes. Record `liftedBySystem` with the reason, as the plan job does. Show
the hold's age on `/leases/[id]`.

### 7. WRONG — An entry is judged as though the notice were served this instant, so an unserved notice clears the entry; and a work order with no ticket enters an occupied house with no notice at all · (a)(c) · M · MAINT-05/COMM-02/RISK-06, R-027/R-080/R-157/R-210/R-211, D-47/D-228

**Half one: the check decides before service is known.** `scheduleWorkOrder`
calls `entryDecision` with `noticeServedAt: now`
(`apps/web/lib/workorders/scheduling.ts:145-155`). The comment argues that
serving happens *"as part of this same action"*. Since R-210, it does not:

- The notice is written with its service columns empty whenever the tenant
  cannot receive a sign-in link (`:187-200`).
- The decision has already said `notice_served, permitted: true`.

So the visit is scheduled, the vendor comes, and the record shows an entry
authorised by a notice that `/notices` itself lists as not served. Both R-210
and R-211 recorded this as *"owned by nobody"*.

**Half two: no ticket means no notice.** The notice is generated only
`if (leaseId && tenant)`, and both come from `workOrder.ticket`
(`scheduling.ts:176-187`). R-080's preventive maintenance creates one work
order per unit with no ticket and no lease (`maintenance/preventive-actions.ts:
119-127`), on occupied and vacant units alike. The same is true of any work
order a PM raises directly. So:

- **Visits with no notice.** The furnace service, the smoke-detector test and
  the gutter job on an occupied house get **no entry notice generated at
  all**.
- **Mislabelled.** The decision is labelled `notice_served`, because
  `entryNoticeHours` is configured and `now` counts as served.

**What that costs.** Unlawful entry is an easy, statutory-damages claim, and
it is a standard counterclaim in an eviction. At this scale preventive visits
run four or more times a year per house, so a 30-door portfolio makes **120+
entries a year** on this path. **Needs counsel** on damages. The engineering
does not need counsel.

**Fix:**

- Resolve the tenancy from the unit's in-force lease, not from the ticket.
- Judge the entry against the notice's real `servedAt`. An unserved notice
  goes through the existing override path, with its reason recorded.
- Preventive work orders on occupied units take the same path, and are held
  as unscheduled until a notice has been served.

### 8. WRONG — The chase ladder speaks three times in a tenancy's first arrears episode and never again · (a)(c) · S · PAY-06/PAY-07, R-179/R-206, D-189

**The ladder matches three exact days.** `chaseRungDue` matches days past
grace **exactly** against `[1, 5, 15]` (`packages/core/ledger/aging.ts:
363-368`), and `payments.chase` raises a Task only on a match
(`apps/web/lib/payments/chase-job.ts:71-72`).

**After R-206 the anchor never moves forward while the debt is unpaid.** It
is the oldest unpaid **period**, which is now correct. That means `daysLate`
climbs past grace + 15 and stays past it for as long as the arrears exist.

**Worked example.** A tenant misses May and June. They get three chase Tasks
in May's first fortnight. June's unpaid rent is a second unpaid period behind
the same anchor, so it produces no rung. July produces none either. From day
16 of the episode onward, **the only prompt anybody gets is the rent roll's
sort order**. R-206's leftovers name this, and nobody owns it.

**What that costs.** The ladder's own label calls rung 15 *"final chase
before a notice"*, but nothing raises the notice Task that the label implies
comes next. A tenancy 45 days behind looks, to the queue, exactly like one
that paid. At this scale one quietly-ignored second month is $1,500 of arrears
that is one month older when somebody finally files.

**Fix:** re-arm the ladder per unpaid period (key the rung on the newest
unpaid period's own days past grace, not the oldest's). Add a fourth,
standing rung: an URGENT "decide: plan, notice or write-off" Task at grace +
30, repeated weekly under R-191's cool-off while the balance stands. A
`halt_dunning` hold still suppresses all of it.

### 9. WRONG — A vacant unit with no asking rent on file costs nothing, so vacancy loss and economic occupancy are overstated in the direction that hides the problem · (a) · S · RPT-01/RPT-05/LEASE-12, R-050/R-167, review 09-05 §12

**`marketRentCents` is nullable** (model `Unit`), and nothing requires it at
creation (`apps/web/lib/units/actions.ts:51`). `dailyCostOfVacancyCents`
handles a null honestly and returns null (`packages/core/units/vacancy.ts`).
Its comment gives the reason: *"zero would read as 'costing nothing' rather
than 'not priced'"*.

**Two totals then add that null as zero:**

- `rentRoll`'s `vacancyLossCents` sums `unit.marketRentCents ?? 0`
  (`apps/web/lib/payments/rent-roll.ts:153`).
- The dashboard's `totalDailyCostCents` sums `u.dailyCostCents ?? 0`
  (`apps/web/lib/dashboard/queries.ts:248`).

Neither says that any unit was left out.

**The operating report shrinks its denominator instead.** It skips the unit
correctly (`reports/operating.ts:242-245`). But `economicOccupancy` divides
collected rent by *scheduled + vacancy loss + concessions*
(`packages/core/metrics/operating.ts:363-372`), so every unpriced vacant day
**shrinks the denominator** and pushes economic occupancy **up**.

**When units are unpriced.** Units come in unpriced from import (R-168a
carries the field but does not require it) and from anybody adding a unit in
a hurry. The house that has sat empty longest is often the one nobody priced.

**What that costs.** Two unpriced $1,500 houses vacant for 60 days are $6,000
of vacancy loss missing from the rent roll and from the operating report's
denominator. They are also missing from the dashboard's $/day tile, which
reads about $100/day low. That tile is the number that is supposed to make
somebody hurry.

**Fix:**

- Count unpriced vacant units beside the total ("+2 unpriced").
- Price them from the last lease's rent when there is one.
- Report economic occupancy as null, with a reason, when any vacant unit in
  the window is unpriced. That is the posture `economicOccupancy`'s own
  comment already takes for a zero denominator.

### 10. WRONG — Three money reports name whichever tenant the database happens to return first · (a) · S · PAY-06/PAY-04/PAY-08, R-044/R-040/R-175, D-34

Most sites that name "the tenant" order or filter by `isPrimary`: provision,
notices, showings, inspections and the deposit letter. Three do neither:

- **`rentRoll`** (`apps/web/lib/payments/rent-roll.ts:129-131`, read at
  `:272`) takes `leaseTenants[0]` unordered. It then computes
  `lastContactOn` from **that person's** thread (`:306-308`). For a
  two-adult household the "last contacted" column can read *never* the
  morning after the primary tenant was texted. PAY-06 put that column there
  precisely to separate a tenancy nobody has spoken to from one reminded
  twice this week.
- **`waiverPatternByTenant`** (`apps/web/lib/ledger/waiver-report.ts:56-58`,
  read at `:70`) attributes each waived fee to an arbitrary co-tenant. D-34's
  report exists to show **who** is forgiven. A household's waivers split
  across two names, differently on different runs, halves the apparent rate
  for exactly the pattern it should expose.
- **`plan-report.ts`** (`:102-104`, read at `:127`) has the same shape.

Postgres guarantees no order without `ORDER BY`, so the same report can name
different people on different days. That is invisible in every fixture,
because every fixture lease has one tenant.

**Fix:** add `orderBy: { isPrimary: 'desc' }` on all three. For the rent
roll, compute `lastContactOn` across **every** party on the lease, which is
what the question actually asks.

### 11. Preventive maintenance still auto-assigns an uninsured vendor, and the COI warning cannot see it · (c) · S · MAINT-11/MAINT-03, R-080/R-214, D-232

R-214 made a missing certificate read "no COI" and added a warn-and-log at
**dispatch**. R-080's recurring job picks
`fallbackVendorsForTrade(...)[0]` and writes it straight onto every generated
work order (`apps/web/lib/maintenance/preventive-actions.ts:114-127`), with no
COI check and no warning. R-214 recorded this as owned by nobody.

These are the visits most likely to go wrong unattended: roofs, gutters,
HVAC, tree work, sent to every house on a timer. An uninsured gutter man off a
ladder lands on the owner's policy. D-232's warn-and-log should run here too:
skip vendors whose COI is missing or lapsed when ranking, and raise a Task
naming the skip. It is one predicate, and R-214 already wrote it.

### 12. An emergency dispatch the provider bounces at 22:40 is retried at 08:00 · (c) · S · MAINT-03/NOTIF-05, R-207, D-225/D-229

R-207 made the first send of an emergency dispatch bypass quiet hours through
`NotifyInput.urgent` (`apps/web/lib/notifications/send.ts:90, 212`). Its own
`KNOWN GAP` comment at `scheduleRetry` (`:471-479`) says the flag is never
persisted. A retry runs from the stored row, sees only a non-emergency
category, and is deferred to the end of quiet hours.

Twilio refusals are not rare at night (carrier filtering, a full queue, a
transient 5xx). One retry landing nine hours late is finding 2's cost on a
smaller population. The fix is a column on `Notification` plus a migration,
which R-207 named and did not take.

### 13. The deposit-dispute packet lists the photographs instead of containing them · (c) · S–M · INSP-05/PAY-11, R-083/R-218, D-50/D-236

R-218's packet names each condition photograph (`apps/web/lib/deposits/
packet.ts:157-166`) but cannot embed one, because `appendPdfs` takes PDFs
only. R-218's leftover says so, and `NEXT.md` carries it.

An eviction turns on a ledger. A deposit case turns on the photographs, side
by side, dated and signed. A packet that says *"photo IMG_4411.jpg, captured
14 Mar 2024"* hands the judge an index and the operator an afternoon of
printing, and it is the afternoon R-218 existed to remove. Render JPEG and
PNG as pages, paired move-in above move-out per item, carrying the capture
timestamp and the EXIF geotag R-068 already stores. Size to D-137's allowlist
of renderable types.

## Checked and could not confirm

- **`Notification.eventId` index.** R-209's entry recorded that
  `Notification.eventId` "has NO INDEX" against 503,225 rows, which would make
  every `OutboxEvent` delete a sequential scan. The current schema declares
  `@@index([eventId])` on `Notification`. Whether a migration actually created
  it in the database, or R-209 was describing a different table, is
  **unknown**. `db:drift` against `rental_test` would settle it in one command,
  and this review did not run it.
- **Whether a production deploy re-runs `db:seed`.** This decides whether a
  role gains a permission a release adds (for example D-212's `job.manage` for
  managers). It is still **unknown**, as `NEXT.md` says. It is not a row until
  somebody deploys, but it must be answered before go-live.
- **Real Stripe's finalize instant.** `rentPeriodDebts` assumes it lands at
  09:00 property-local on the due day (`aging.ts`, R-205/R-206). That holds on
  the simulator and on test-mode replays. Whether a live subscription with a
  `debitDay` different from its anchor finalizes where the comment says is
  **unknown** until live mode (D-26).
- **Whether a physical lock follows a retired `AccessCode`.** D-182 says
  retiring changes no lock, and I found no smart-lock driver that listens.
  Finding 1's lockout is therefore a record-plus-work-order exposure, not a
  confirmed physical one. If a lock integration is ever wired to
  `effectiveTo`, finding 1 becomes a real lockout that same night.

## What this review structurally could not see

- **Anything only a browser reveals.** Arc 6's own D-28 walk owes that.
  Findings 1 and 9 will be visible there as a house on `/vacancies` with a
  tenant in it, and a dashboard tile that is too small.
- **Anything gated on a real vendor.** Finding 3 is the sharpest case of a
  simulator agreeing with us by construction (D-27): the refusal is
  unreachable in every test and demo, and it becomes certain the day the live
  key is turned on.

## Do not build

- **A settings screen for `CHASE_LADDER_DAYS`, the turn-stage days or the
  stall thresholds.** Five reviews have now declined it. Finding 8 wants the
  ladder re-armed, not configurable.
- **Backfilling anything.** This covers false `moveOutAt` stamps, late fees
  never assessed under a forgotten hold, and unserved entry notices already
  written (D-201/D-222). Report them on a screen and fix the writer. The one
  exception to consider is finding 1's `Unit.status`, which is a mutable
  operational column and not evidence. Setting live-tenancy units back to
  `OCCUPIED` is a correction, not a rewrite of history. It still needs its
  own decision row.
- **A move-in inspection that blocks renewal or occupancy.** Finding 5 wants
  the existing report found, not a new walk demanded of a tenant who has lived
  there three years.
- **Auto-paging on every SMS containing "water".** Finding 2 wants staff able
  to declare an emergency and habitability language to *suggest* one to the
  on-call person. It does not want the rota woken by "the water bill is high".
- **A second queue, Stripe Connect, deposit-interest engines.** These are
  unchanged from the last four reviews and still right.

Files worth reading first, if this becomes a backlog:
`apps/web/lib/units/auto-make-ready.ts`,
`apps/web/lib/leases/renewal-rollover-job.ts`,
`apps/web/lib/maintenance/actions.ts`, `apps/web/lib/comms/sms-intake.ts`,
`apps/web/lib/maintenance/triage-consumer.ts`,
`packages/core/maintenance/priority.ts`,
`apps/web/lib/billing/stripe-adapter.ts`,
`packages/core/payments/offline.ts`, `apps/web/lib/leases/actions.ts`,
`packages/core/leases/renewal.ts`,
`apps/web/lib/inspections/move-out-copy.ts`,
`apps/web/lib/deposits/packet.ts`, `apps/web/lib/notices/actions.ts`,
`apps/web/lib/workorders/scheduling.ts`,
`apps/web/lib/maintenance/preventive-actions.ts`,
`packages/core/ledger/aging.ts`, `apps/web/lib/payments/rent-roll.ts`,
`apps/web/lib/dashboard/queries.ts`, `apps/web/lib/ledger/waiver-report.ts`,
`apps/web/lib/notifications/send.ts`.
