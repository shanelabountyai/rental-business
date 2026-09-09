# Operator review — 2026-09-09

Source for the Arc 4 backlog rows, per D-164's precedent and D-172's. Produced
by the rental-operator agent reviewing the shipped product after R-186 closed
the Arc 3 backlog. Fifteen findings, ranked by operational pain × frequency;
six are behaviour that is **wrong**, not missing. Category key: **(a)** gap in
what shipped · **(b)** new capability · **(c)** recorded debt now
load-bearing.

Two notes that are not findings. **CI is green and was checked, not copied**:
`gh run list` shows R-182's fix run (`34368255042`), R-183 (`34371202028`),
R-184 (`34381705453`) and R-185 (`34387000785`) all completed successfully;
R-186's run (`34391093789`) was still in flight while this was written and is
the one thing to read before the first Arc 4 commit. D-171 is closed — R-170a
found the cause (D-176) and it was never a race. **The one live gate defect is
`e2e/leases.spec.ts`'s cleanup**, named in R-179 and still in `NEXT.md`:
`unit.deleteMany` refuses on `WorkOrder_unitId_fkey` because R-178 made ending
a tenancy open six work orders and the delete races the async writer. It costs
a retry on most pushes and it makes "is this red mine" a live question again.
It needs a row; it does not need a finding.

## Verdict

Arc 3 did what it was asked, and did it better than Arc 2: the five wrong
behaviours from 2026-09-05 are genuinely fixed at the writer rather than at
the readers (D-177 is the model — one `Payment` row, three consumers correct
for free), the refund is now an event with a date and an instrument, the turn
is a sequenced project, the chase reaches every liable party on a schedule,
and a second state can now say how it counts to thirty. The shape is right and
the reasoning in `PROGRESS.md` is better than most production teams manage.

What Arc 3 exposed is a third class of defect, and it is the most dangerous
one so far. Arc 1's defects were missing features. Arc 2's were money that
could not physically leave the building. **Arc 3's are automated decisions
that are silently wrong and look right on the screen** — a repayment plan that
can never break, a statutory refund clock that goes quiet the moment the
letter is sent, a catch-up that stamps a missed day SUCCEEDED having done
today's work, a stall sweep that flags a case once and then never again. Every
one of these presents as a healthy green surface: the plan reads *on track*,
the deposit reads *settled*, the job panel reads *ran*, the case reads *seen*.
The single most consequential gap: **`paidTowardPlan` counts every payment on
the tenancy, so a tenant who keeps paying ordinary rent and nothing toward the
arrears keeps the plan, keeps the late-fee meter off, keeps the chase off, and
is finally marked COMPLETED with the arrears exactly where they started.**

## Findings

### 1. WRONG — A repayment plan counts ordinary rent as instalment money, so it can never break and eventually completes itself · (a) · M · PAY-08/PAY-12, R-175 / D-181

`paidTowardPlan` (`apps/web/lib/payments/plans.ts:50-67`) sums **every**
`PAYMENT` and `CREDIT` entry on the lease since `startedOn`. `planProgress`
(`packages/core/payments/plan.ts:161-224`) then compares that number against
the cumulative instalment total matured to date, and nothing subtracts the
rent charged in between. D-181's own comment states the algebra — *"balance is
`arrearsAtStart + chargesSince − paymentsSince`, so 'has the balance fallen as
fast as the schedule promised' reduces exactly to 'is `paymentsSince` at least
the cumulative instalment total' — the charges cancel on both sides"* — and
that step is wrong. The charges cancel only if they are subtracted from
`paymentsSince` too; the correct predicate is `paymentsSince − chargesSince >=
cumulativeMatured`. Proven, not argued: a $2,400 arrears plan of six monthly
$400 instalments from 1 Nov, against a tenant paying their ordinary $1,500
rent and not one cent more, returns `ACTIVE` with `shortfallCents: 0` in
November and **`COMPLETED`** by April.

What that costs. `payment_plan` carries `halt_dunning` and `halt_late_fees`
(`packages/core/holds/index.ts:131-137`), so for the whole run of the plan no
late fee is assessed, no rung of R-179's ladder fires, and no `rent.chase`
Task is raised — against a tenancy whose arrears never moved. Then
`payment-plan-job.ts:77-110` marks it COMPLETED, lifts the hold, and raises a
ROUTINE *"plan paid in full"* Task. The product's own record now says the
tenant satisfied a repayment agreement they never paid a penny into, which is
the worst possible document to be holding in front of a judge six months
later. The inverse case D-181 does discuss (paying instalments and nothing
toward new rent) is the harmless one — the rent roll shows a growing balance.
This one is invisible on every screen. Fix: `paidTowardPlan` nets the charges
raised since `startedOn`, or `planProgress` takes the balance rather than a
payment total. Also drop `CREDIT` from the count for D-181's own stated reason
— *"a plan kept by an adjustment is a plan kept by us"* — a concession is us.

### 2. WRONG — Once the disposition letter is sent, nothing anywhere watches the refund deadline · (a)(c) · S · INSP-05/PAY-11, R-169/R-170's chain

R-170 built the refund event properly and named this gap in its own leftovers;
one item later it is load-bearing. Both surfaces that watch the deposit clock
filter on the letter, not on the money.
`deposit-disposition-reminder-job.ts:27` selects
`{ dispositionDueOn: { not: null }, dispositionSentAt: null }`, and
`reports/queries.ts:239` does the same for the `DEPOSIT_DISPOSITION_DUE`
upcoming date. So the halfway nudge, the overdue alarm and the calendar all go
silent at the moment the letter is generated — while in Texas §92.103 the
refund and the itemization run on **one** clock, so the obligation the letter
creates is still live and now unwatched. The only surface left is the
`deposit_refund_due` Task, and it is dated wrong: `deposits/actions.ts:315`
sets `businessDate: businessDate(new Date(), …)` — the day the letter was
finalized, not `dispositionDueOn` — so it reads *Overdue* from the following
morning and never once names the real statutory date. A queue where the
URGENT item is overdue on day two is a queue nobody reads on day twenty.
**Needs counsel** on whether a timely itemization with a late refund is a
partial defence or no defence at all; either way the operator should be able
to see the date. Fix: both readers key on `refundPaidOn IS NULL AND
refundedCents > 0` as well as on `dispositionSentAt`, and the Task carries the
deadline as its business date.

### 3. WRONG — The photograph a tenant texts at 11pm is thrown away at the door, and the email path stores the same photograph · (a) · M · MAINT-01/COMM-01/COMM-08, R-021/R-097d/R-177/R-181

`apps/web/app/api/sms/inbound/route.ts:75-77` reads exactly three fields off
Twilio's form — `From`, `Body`, `MessageSid` — and `handleInboundSms`
(`apps/web/lib/comms/sms-intake.ts:46-51`) accepts only those. `NumMedia` and
`MediaUrl0…N` are never read anywhere in the repo. Meanwhile the email path
does it right and has since R-097d: `inbound-attachments.ts` stores the file
with a closed type list, a size cap and a count cap, and `email-intake.ts:146-153`
re-parents those `Document` rows onto the ticket with a comment that says
exactly what is at stake — *"without it a tenant photographs a leak and the
person sent to fix it never sees the picture."* That is the state of the SMS
path today, on the channel R-021 measured as roughly half of all intake and
the one this product deliberately built for the tenant who will not log in.
Three losses, compounding: the vendor is dispatched blind, the append-only
`Message` trail is missing content the tenant demonstrably sent, and R-181's
`ticket.acknowledged` now texts back *"we have your request"* while the
evidence they attached is gone. The habitability photo, the water-heater pan,
the damage a tenant photographs on the day they move out — all of it. Fix:
fetch the media with the Twilio credentials already wired by R-104 (no new
vendor relationship — this is R-093-adjacent only in that it is the same
provider already in use), hand the bytes to the existing
`storeInboundAttachments`, and re-parent onto the ticket exactly as
`email-intake.ts` does. Drop-and-count for an unrouted message, which that
module already implements.

### 4. WRONG — A caught-up job runs a missed business date with today's clock and is then recorded as having succeeded on that date · (a) · S–M · PRD §6.5/§6.6, R-174 / D-180

`apps/web/lib/jobs/runner.ts:252` calls `claimAndRun(job, property, date, now)`
for each missed business date — passing the **real** `now` alongside a
*historical* `businessDate`. Every job that reads the clock instead of the
parameter therefore does today's work under yesterday's label. Six of the
twenty-two do exactly that: `ledger.late_fees` (`late-fee-job.ts:27` destructures
`{ propertyId }` only, and `assessLateFees` defaults `now = new Date()`),
`billing.sweep`, `billing.due_notices`, `billing.card_expiry`,
`billing.predebit`, and `payments.chase`, which passes `now` straight into
`rentRoll()` (`chase-job.ts:51-58`). Two consequences, and the second is the
one that hurts. **The ladder loses the rung**: `chaseRungDue` matches days past
grace *exactly*, so a cron gap over the day a tenancy hit rung 5 produces a
catch-up run computing rung from today's aging, returning null, and that rung
never fires for that tenancy — while `createTask`'s key is
`(type, subjectId, businessDate)` (`tasks/create.ts:44-56`), so the three
catch-up dates plus today each mint a **separate identical** chase Task with
today's amount on it. **And the `JobRun` row is written SUCCEEDED for the
missed date**, so R-174's whole panel — the item built precisely so a legal
clock cannot stop unnoticed — reports the day as done. Late fees survive this
by luck (`postLateFeeDelta` is delta-keyed on `latefee:${charge.id}:${today}`),
which is exactly why it has not been noticed. Fix: pass an instant consistent
with the business date being replayed, and have a job that genuinely cannot be
re-dated say so rather than claim the day.

### 5. WRONG — The stall sweep flags a case once and then never again, including the FHA response clock · (a) · S · RISK-13/D-89, R-158/R-178

`alreadyFlagged` (`apps/web/lib/cases/case-stall-job.ts:32-35`) is
`prisma.task.findFirst({ where: { type, subjectId } })` — no `businessDate`,
and **no status filter**. R-158's comment defends the missing date (one Task,
not thirty) and that reasoning is right. The missing status filter is not:
once the Task has been completed or canceled it still matches, so the
condition can never raise a second one. A turn that stalls in trash-out, gets
flagged, is unstuck, and then stalls again on floors six weeks later is
flagged exactly zero more times. The sharp case is the first one in the file:
`accommodation.response_overdue` is raised at **EMERGENCY** because D-89 says
an unanswered accommodation request reads as denied — and if somebody marks
that Task done without actually deciding the request, the escalation never
fires again for the life of that request. Same shape for
`abandonment`, `violations`, `evictions`, `disputes` and R-178's
`turnover.stalled`. Fix: exclude `DONE`/`CANCELED` from the lookup and add a
cool-off (the last flag's business date + N), which keeps R-158's "not thirty
tasks" property while letting a re-stall be seen.

### 6. WRONG — An online payment can claim a counter payment's row, and the second payment then exists nowhere · (a) · S · PAY-01/PAY-05, R-171 / D-177

D-177's claim branch (`apps/web/lib/billing/webhook.ts:535-552`) runs when
`intent.stripePaymentIntentId == null && intent.stripeInvoiceId != null`, and
`events.ts:386` records that the account's own API version
(`2026-07-29.dahlia`) **dropped `payment_intent` from the invoice object** —
so that condition is true for *every* invoice-driven payment, online card and
ACH included, not only for out-of-band ones. The lookup then matches any
`SETTLED` row on the same payer, invoice and amount with `receivedByStaffId`
set and no ledger entries, `orderBy: { receivedAt: 'asc' }`, and returns it
unchanged. The webhook's comment argues the discriminator is exact and it is —
in the direction it was tested. In the other direction an *online* payment
event can claim an *offline* row: a $750 counter cheque whose own
`invoice.updated` never arrived (a dropped webhook, a signature failure, an
outage) sits unclaimed for ever, and the next $750 online payment on that
invoice lands on it, returns it unchanged, and writes one ledger entry for two
payments. The tenant is credited once, the balance stays $750 high, and the
`Payment` row says *cheque, received by Dana at the counter* for money that
came off a card. Whether an unclaimed row can actually persist in production
depends on real Stripe redelivery and is recorded here as **unknown** — the
code path is verified, the production frequency is not. Cheap fix: bound the
claim to rows received within a day or two of the event, and count
unclaimed-older-than-N offline rows on `/money`'s existing drift surface.

### 7. Nothing records a property expense that is not a vendor invoice, so "All expenses" and "Net" exclude taxes, insurance and management · (b) · M · RPT-05/RPT-07, R-078/R-081

`/reports/operating` prints a column headed literally **"All expenses"** and
one headed **"Net"** (`app/(admin)/reports/operating/page.tsx:196-201`), sorted
*worst net first*, with no caveat anywhere on the page. What actually feeds it
is R-078's export lines: work orders, vendor-invoice splits, utility bills,
eviction costs and mortgage interest from a 1098 (`packages/core/tax/export.ts:414-570`).
`UNFILLABLE_NOTE` (`packages/core/tax/packet-document.ts:36`) is honest about
the rest, and it is a long list: advertising, auto and travel, commissions,
**insurance**, legal beyond eviction, **management fees**, other interest,
supplies and **taxes**. Property tax and the landlord policy are the two
largest recurring costs on a single-family rental after debt service — on a
$1,500/month house they are commonly a third of gross rent — and neither can
be entered anywhere in this product. So the per-property Net is overstated on
every house, the "worst net first" ordering the page exists to give is a
ranking on a partial cost base, and the lemon test compares houses by a number
that omits the largest thing that differs between them (a house in a 2.7%
county against one in a 1.9% county). The tax packet discloses it on the PDF;
the screen the owner actually reads monthly does not. Fix: a `PropertyExpense`
row — property or entity, `bookedOn`, a `ScheduleEKey`, amount in cents,
optional document, optional monthly recurrence — feeding the same export
pipeline. This is not a ledger write and D-11 does not reach it: `LedgerEntry`
is the tenant-receivable projection, and vendor invoices already establish
that owner-side outlay lives in its own table.

### 8. Nothing records what a notice demanded, so nothing can say the tenant cured · (b) · M · PAY-14/LEASE-13, R-051/R-083/R-156

`Notice` (`schema.prisma:5539-5580`) has a type, an address of record, a body,
a document and its deliveries — and **no amount**. The sum demanded exists
only as text rendered from `balance.total`
(`packages/core/comms/merge-fields.ts:76`) inside `bodyText`. So `cureClock`
takes days and services and no money at all, and `cureClockFor`
(`apps/web/lib/evictions/queries.ts:129-147`) can only list *payments received
since service* beside a generic waiver warning. The one question an operator
has to answer before spending a filing fee — **did they pay what we demanded,
in full, inside the cure period?** — is answered by eye, from two numbers on
different parts of the screen, at the moment the answer is most expensive to
get wrong. Filing on a cured notice is a dismissal, the filing fee, the
process-server fee and an attorney's afternoon; not filing when they have not
cured is a month of possession. Fix: store `demandedCents` (and what it is
composed of) on the `Notice` at generation, and have the cure clock report
*cured / part-cured / not cured* against payments kept since service, next to
R-156's acceptance band. **Needs counsel** on whether a partial payment cures
and on whether accepting it waives — the second is already a
`JurisdictionRule` three-valued field, so the pattern exists.

### 9. Twenty-one of twenty-four Task subject types dead-end · (a) · S · PRD §6.5, D-9 — made load-bearing by R-158/R-174/R-175/R-178/R-179

`/tasks/[id]` resolves a subject for exactly three types: `Ticket`
(`app/(admin)/tasks/[id]/page.tsx:84`), `WorkOrder` (`:106`) and R-170's
`Deposit` link (`:116-121`). A grep of `subjectType: '…'` across
`apps/web/lib` returns **24 distinct types**, so a task on a `Lease` (nine
producers, including every rung of R-179's chase and both payment-plan
outcomes), an `AccommodationRequest`, an `AbandonmentCase`, a
`TurnoverProject`, a `JobRun`, a `LeasePayer` or an `EvictionCase` renders a
title and nothing else. Five separate items have recorded this in their own
leftovers — R-158's five types, R-178's sixth, R-179's `rent.chase`, R-174's
`job_failed` — each correctly noting it was not theirs to fix. It is now the
commonest thing in the queue. A PM working a morning list copies a unit name
out of a title and searches for it, on every task that is not a ticket or a
job, which is the tax D-9's single queue was supposed to remove. Fix: one
`subjectHref(subjectType, subjectId)` resolver behind the same per-type scope
check the three existing branches already apply, and the link rendered from
`/tasks` as well as from the detail page.

### 10. The guarantor is chased down three channels and reachable on none of them · (a) · M · LEASE-06/COMM-03/PAY-06, R-165/R-179 (D-190)

R-179 correctly added guarantors to the chase, and correctly gated their SMS
on consent (D-190 — a co-signer texted about somebody else's debt is the
archetypal TCPA claim). The result today is that a guarantor is addressed and
reached by nothing but email. `TenantConsent` is keyed on `tenantId`
(`schema.prisma:6326-6347`) and `send.ts:218-228` looks the guarantor's own id
up in that table, so **every guarantor SMS is `no_consent` for ever** — there
is no form, no column and no path by which a guarantor could consent even if
they wanted to. `rent_reminder` also fans out to PORTAL, and the guarantor
portal has no inbox at all (LEASE-06), so that row is written and read by
nobody. Net effect for a guarantor with a phone and no email — which is the
common shape for the parent co-signing for a thin-file applicant — is three
delivery rows, none of which reaches a human, on the one communication whose
entire purpose is that somebody answerable hears about the arrears before a
filing. Worse for the trail: R-173 taught the engine that a portal nobody can
sign into is not a delivery, and that fix was scoped to `Tenant`. Fix: a
consent record a guarantor can be the subject of (widen the key, or a
`ConsentSubject` discriminator), `reachableElectronically`'s predicate applied
to guarantors, and either a guarantor inbox or PORTAL dropped for that
recipient type.

### 11. `/jobs` is owner-only, so the person holding the failed-job task cannot open it · (a) · S · PRD §6.6/ROLE-02, R-174

`job.manage` exists in `PERMISSIONS` (`packages/core/rbac/permissions.ts:159`)
and appears in **no role but `owner`** — the `manager` role's list
(`:267-322`) carries `eviction.manage`, `hold.manage` and
`hold.lift_protected` and not this. R-174 recorded it as a leftover and it is
the half that matters: `raiseFailureTask` assigns the `job_failed` Task
without regard to who can act on it, so the manager who picks it up cannot
open `/jobs`, cannot read the error, and cannot press the re-run — and the
re-run is the only way a `FAILED` row is ever retried, because the runner
deliberately does not retry (`runner.ts:318-325`). The scenario is exactly the
one the item was built for: the deposit-disposition reminder or the court-date
job fails at 5am, the owner is on a plane, and the person who is awake is
locked out of the screen that would fix it. Fix: add `job.manage` to
`manager`, or split read from re-run and give the manager the read. Both are
one line and a seed.

### 12. Nothing records the inter-entity sweep, and the settlement report is not an artifact · (a)(c) · S–M · PROP-02/RPT-07, R-180 / D-191

R-180 built the right half of finding 12 and its own leftovers name what is
missing. Today a per-entity settlement figure can be computed on demand and
nothing records that the owner acted on it: there is no transfer row anywhere
in the schema (a grep for `transfer` returns only
`DepositTransferStatus`, which is R-092's property-sale field), and
`reports/settlement.ts` has no archive path, unlike R-081d's tax packet which
is deliberately archived as a `Document`. So the sentence an accountant or an
opposing attorney actually asks for — *"on 4 October you moved $6,412 from the
shared operating account to Maple Holdings LLC, and here is the report it was
computed from"* — cannot be produced from this product at all. The commingling
risk R-180's own header describes is not closed by a number you can
regenerate; it is closed by a dated record of the movement with the evidence
attached. Fix: an `EntitySettlement` (window, entity, gross cents, the
archived report `Document`, transferred-on, reference, who) raised from the
report page — the same shape `recordDepositRefund` already establishes for
money going out, and R-081d's precedent for archiving the artifact rather than
promising to re-derive it. **Needs counsel** stays on the *connected account*
question only, which remains out of scope.

### 13. The payment plan is not evidence: nothing signed, nothing sent, nothing the tenant can see · (a) · M · PAY-08/LEASE-08, R-175

`PaymentPlan` carries `note` — free text typed by whoever agreed it — and
that is the entire record of what was agreed. R-175's own leftovers name both
halves: no e-sign on the agreement, and no tenant-facing view of the schedule.
The consequence is felt the first time a plan goes wrong, which is the only
time anybody looks: the tenant says the instalment was $250 and the note says
$400, and the product's answer is a row a staff member typed. Nothing was ever
sent — there is no template for the schedule, so a plan agreed on the phone
produces no message, no document, and no `Notification` row proving it was
communicated. Then the sweep breaks it and raises an URGENT Task on a
tenancy that can truthfully say it was never told what it had agreed to. The
e-sign machinery already exists (R-063/R-090), the document generation already
exists (R-062), and the portal already renders per-lease panels. Fix, in
value order: send the schedule when the plan is agreed (one template, the
instalment table, the `Message` row *is* the evidence); show it on the portal
lease page; e-sign only if the operator wants it — the first two carry most of
the defence.

### 14. LEASE-12's and LEASE-09's notice checks still count calendar days whatever the jurisdiction says · (c) · M · LEASE-09/LEASE-12/PRD §6.7, R-182 / D-193

R-182 gave `JurisdictionRule` a `dayCountBasis` and routed five statutory
clocks through `statutoryDeadline`, and named the two it could not convert.
They are the two that decide whether a *notice somebody gave* was good:
`noticePeriodCheck` (`packages/core/leases/notice-to-vacate.ts:51-68`) computes
`Math.floor((effectiveOn − givenOn) / 86_400_000)` off two `Date`s, and
`renewalCheck` does the same for a rent-increase notice period. Both are
therefore deaf to `BUSINESS` and to `CALENDAR_ROLL_FORWARD`. That is a
different failure from a deadline being a day out: these two produce the
`needsOverride` flag a PM ticks past to accept a short notice, so in a
business-day state the product will wave through a notice that was actually
short — and, in the other direction, demand an override for one that was
fine, teaching the operator that the check is noise. `computeCoverage` now
lists both as `productLimits` on the screen that gates a state going
effective, which is the honest interim and is why this is (c) rather than (a).
It becomes real the day a second state is configured, which R-162 made easy.
`assessEvidence`'s abandonment presumption is the same shape and is not even
covered by the warning.

### 15. A raw `YYYY-MM-DD` still reaches four operator- and tenant-facing surfaces · (a) · S · D-153/D-154/D-198, R-116/R-129/R-185

Fifth instance of the class, and the sharpest one is on the deposit deadline
this review has already flagged twice.
`deposit-disposition-reminder-job.ts:71-72` builds the Task titles
*"Deposit disposition OVERDUE (was due 2026-09-30) — 12 Oak"* and the halfway
equivalent, interpolating `due` — a `BusinessDate` off `utcToBusinessDate` —
straight into the string. Three more live sites, all outside the JSX the
D-154 predicate scans: `payments/deposit-actions.ts:127` titles the deposit
slip `Deposit slip — Maple Holdings LLC — 2026-09-08`, which is a `Document`
name an operator files and a bank clerk reads;
`components/consent/consent-panel.tsx:172` labels a consent row *"…recorded
2026-08-14"*, on the screen whose whole job is proving when consent was
obtained; and `packages/core/leases/party-change.ts:169,175` refuses an
amendment with *"The tenancy did not start until 2026-03-01."* R-185 fixed the
three merge catalogues and this is what it could not see, for D-154's stated
reason — the value is already correctly a `BusinessDate`, so nothing formats
it wrongly because nothing formats it at all. Fix is `friendlyBusinessDate` at
each of the four, and the predicate to re-run is
`grep -rnE '\$\{[a-zA-Z_][a-zA-Z0-9_.]*(due|Due|On|Date)\}'` restricted to
`title:`/`label:`/`message:`/`description:` positions, which is what found
these.

## Do not build

- **Deposit refund accrual, interest engines, and anything else keyed on a
  second state that has not been onboarded.** R-183 made the gap loud, which
  was the right call and remains it. Finding 14 is the same posture: the
  coverage screen naming the limit is the shipped answer until a property in
  such a state exists.
- **Stripe Connect / a connected account per entity.** Unchanged from the last
  two reviews and still correct. Finding 12 is the cheap, reversible half, and
  the full version needs a legal-structure decision nobody has taken.
- **A settings screen for `CHASE_LADDER_DAYS`, `TURN_STAGE_DAYS`,
  `TURN_STALL_DAYS`, `PLAN_GRACE_DAYS` or the case-stall thresholds.** Three
  reviews have now declined this and three arcs have proved it right. House
  rules with the reasoning beside them; D-4 governs numbers a legislature can
  change, and none of these is one.
- **A second queue for job failures, refunds due, or chase rungs.** D-9 has
  been paid for three times. Findings 2, 9 and 11 all want the *existing* Task
  queue to be reachable and correctly dated, not another table.
- **Backfilling anything.** The doubled `Payment` rows from D-169, R-038a's
  no-ledger payments, the `payment_plan` holds R-175 declined to adopt, and
  now any plan that finding 1 completed wrongly. Report them, fix the writer,
  leave reconciled history alone — the corrective write has the bigger blast
  radius every time.
- **A per-stage table for the turn, or a second definition of "days vacant".**
  D-184's derived-on-read plan is the right shape and R-172's `startsOn`
  fallback is the right reconciliation. Neither needs revisiting.
- **Chasing the `leases.spec.ts` cleanup flake as a product defect.** It is
  spec hygiene with a known cause (R-178's six work orders racing the delete)
  and a known fix (order the delete against the async writer, clean up by
  ownership). It needs a row, not an investigation.

Files worth reading first, if this becomes a backlog:
`apps/web/lib/payments/plans.ts`, `packages/core/payments/plan.ts`,
`apps/web/lib/leases/deposit-disposition-reminder-job.ts`,
`apps/web/lib/reports/queries.ts`, `apps/web/app/api/sms/inbound/route.ts`,
`apps/web/lib/comms/inbound-attachments.ts`, `apps/web/lib/jobs/runner.ts`,
`apps/web/lib/cases/case-stall-job.ts`, `apps/web/lib/billing/webhook.ts`,
`packages/core/tax/export.ts`, `apps/web/app/(admin)/tasks/[id]/page.tsx`,
`packages/core/rbac/permissions.ts`, `packages/db/prisma/schema.prisma`.
