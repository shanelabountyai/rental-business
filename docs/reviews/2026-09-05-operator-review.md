# Operator review — 2026-09-05

Source for the Arc 3 backlog rows, per D-164's precedent. Produced by the
rental-operator agent reviewing the shipped product after R-168a closed the
Arc 2 backlog. Fifteen findings, ranked by operational pain × frequency;
five are behaviour that is **wrong**, not missing. Category key: **(a)** gap
in what shipped · **(b)** new capability · **(c)** recorded debt now
load-bearing.

One note that is not a finding: **D-171** has CI red on `main` on a
`mobile-chrome` pointer-interception race in `import.spec.ts` and
`inspections.spec.ts`. It is correctly left unchased — but it means the next
arc starts with a gate that cannot distinguish "my change broke this" from
"this was already red." Whoever picks up Arc 3 item one should read D-171
before reading a stack trace.

## Verdict

Arc 2 did what it was asked: the five wrong behaviours from 2026-09-02 are
actually fixed, not papered over, and the additions are the right ones — a
stall sweep, a court-date job, an append-only `Notice`, a guarantor who
exists, a tenant who has a say, import tooling that a real spreadsheet can
drive. The shape is still right. What Arc 2 exposed is a different class of
defect from Arc 1's: **the product is now excellent at deciding what is owed
and nearly silent about money and obligations physically leaving the
building.** It computes a deposit refund, writes the letter promising it,
and has no way to pay it. It starts the statutory clock for that letter on
the wrong calendar day for any evening move-out. It counts every payment
taken at the counter twice on the owner's Monday tile. Twenty scheduled jobs
now carry legal clocks and nothing anywhere reads whether they ran. The
single most consequential gap: **the deposit-defence epic ends at the
letter — nothing in this product returns the money, records that it was
returned, or knows if it never was.**

## Findings

### 1. WRONG — The statutory deposit clock starts a day late for any evening move-out · (a) · S · INSP-05 / PAY-11, R-071/R-154's chain

`apps/web/lib/leases/deposit-disposition-start.ts:49` reads `const
moveOutDate = utcToBusinessDate(lease.moveOutAt)`. `Lease.moveOutAt` is a
real `DateTime` (`schema.prisma:2331`), written as `moveOutAt: now` — the
exact instant a PM presses the button (`apps/web/lib/leases/actions.ts:513-514`).
`utcToBusinessDate` is the date-only reader. A PM in Houston ending a
tenancy at 7:30pm CDT is 00:30Z the next day, so the clock anchors one
calendar day late and `dispositionDueOn` — the statutory deadline this
product enforces — computes one day past the real one. This is the same
defect class R-156 already found and fixed once on the cure clock, and the
PROGRESS entry says so in as many words ("a 9pm Chicago service started the
cure clock a calendar day late"). Three more live instances survive:
`deposit-disposition-reminder-job.ts:40` (so the halfway and overdue nudges
skew with it, and `overdue = today > due` means the first alarm can land two
days past the true deadline), `turnover/queries.ts:74`, and
`dashboard/queries.ts:233` — where the line two above it correctly uses
`businessDate(unit.createdAt, zone)`, so the right and wrong readers sit two
lines apart in one function. `startDepositDisposition` does not even select
`property.timezone`, so the fix is a select plus four call sites. **Needs
counsel** on the second half: `moveOutAt` is *when staff clicked*, not the
tenant's last day of possession, and in many states the clock runs from
surrender. A PM who records Friday's move-out on Monday loses three days of
a thirty-day window and nothing anywhere says so.

### 2. WRONG — The refund is computed, promised in writing, and cannot be paid · (a)(b) · M · INSP-05, PAY-11

`finalizeDisposition` (`apps/web/lib/deposits/actions.ts:255-289`) computes
`totals.refundedCents`, writes it onto the `Deposit` row, creates a real
`DEPOSIT_DISPOSITION` `Notice` telling the tenant what they are owed, and
stops. `Deposit` (`schema.prisma`) carries `appliedCents` and
`refundedCents` and **no `refundPaidAt`, no `refundMethod`, no cheque
number, no document link**. A grep for `refund` across `apps/web/lib` and
`packages/core` returns only Stripe's inbound `refund` webhook intent and
prose: there is no refund action, no Task raised to cut a cheque, no Stripe
refund path, no entry in the deposit batching R-166 built. So the product's
own record says the money went back — the rent roll's held-deposit line
drops by `refundedCents` (`payments/rent-roll.ts:239`) — while nothing in
the system knows whether a cheque was ever written. In most states the
deadline is *return the balance and the itemization*, not the itemization
alone; the letter this product generates is a signed admission of the
amount owed with no matching proof of payment, which is worse evidence than
having sent nothing. Fix: a refund is an event with a date, an instrument
and a document, raised as a `Task` the moment the disposition is finalized,
blocking the deposit from reading as settled until it is recorded — and the
`Deposit` liability is only released by that event, never by the letter.

### 3. WRONG — Every payment taken at the counter is counted twice in "collected" · (c) · S–M · PAY-05, RPT-01/RPT-05

D-169 recorded that `recordOfflinePayment` writes one rich `Payment` row
*and* provokes a second generic `channel: OTHER` row through `writePayment`,
and correctly declined to fix it under R-166. What D-169 traced was one
consumer (`listUndepositedDepositGroups`, which filters by channel and is
safe). It did not trace the aggregates. `apps/web/lib/dashboard/queries.ts:111`
and `apps/web/lib/reports/queries.ts:91` both run
`prisma.payment.aggregate({ status: 'SETTLED', ... })` with no channel
filter — so the owner's Monday dashboard tile ("$X collected / $Y billed")
and the per-entity cash summary on `/reports` **double every cheque, money
order and cash payment**. Worse for the evidence trail:
`apps/web/lib/evictions/queries.ts:126` builds R-156's acceptance band from
the same unfiltered `Payment` read, so a $400 partial paid at the counter
during a cure window prints as **two $400 payments** on the eviction case
page and in the packet's "Payments accepted after service" exhibit — a
document that goes to a court, overstating by 100% the money whose
acceptance may have waived the notice. The tenant statement is unaffected
(it reads `LedgerEntry`, which is written once), which is exactly what makes
this hard to spot: the tenant's copy and the owner's copy disagree. This is
now load-bearing on three surfaces that did not exist when D-169 was
written.

### 4. WRONG — Days vacant never stops counting · (a) · S · LEASE-12 / RPT-05, R-072 & R-167's chain

`Lease.moveInAt` has no writer anywhere in the codebase — R-160's entry
noted it in passing ("noted, not fixed — out of scope here") and nothing
owns it. `getTurnoverForUnit` (`apps/web/lib/turnover/queries.ts:79-93`)
finds the next tenancy with `where: { moveInAt: { not: null } }`, so
`nextLease` is **always null**, `filledOn` is always null, and
`daysToFill` therefore always returns `isFinal: false` measured against
today. A turn that took eleven days last March reads "179 days vacant and
counting" on the unit page forever, and `daysVacantIsFinal` — a field built
specifically to tell the reader which number they are looking at — is a
constant. Days vacant is the most expensive number in this business and it
is the one number on the turn screen that can never be right. The operating
report and the leasing funnel each dodge it by falling back to
`lease.startsOn` (`reports/operating.ts:82`, `reports/funnel.ts:178`), so
the portfolio-level figure is roughly right while the per-unit one a PM
actually works from is not — two definitions, neither reconciled. Fix: write
`moveInAt` where the tenancy actually starts (move-in inspection completion,
or key/code issuance, which R-069 already logs), and until then make
`getTurnoverForUnit` fall back to `startsOn` the way its two siblings do.

### 5. WRONG — A tenant with no email is recorded as notified through a portal they cannot sign in to · (a) · M · NOTIF-01/NOTIF-05, COMM-04, PRD §6.4's "Gene acid test"

`addressFor` in `apps/web/lib/notifications/send.ts:692-698` returns
`recipient.id` for `PORTAL` — the comment says "the notification IS the
delivery." But `requestTenantMagicLink`
(`apps/web/lib/auth/actions.ts:452-461`) resolves a tenant **by email
address only**, and `tenant-magic-link` is the only tenant auth provider
wired. `Tenant.email` and `Tenant.phone` are both nullable. So for the
long-term tenant with neither on file — the one the PRD names as the acid
test — every locked-category notice, including an entry notice, is recorded
as a `SENT` portal delivery to an account that provably cannot be reached,
while `EMAIL` and `SMS` are both `SUPPRESSED` with `no_address`. D-38's
Task, the one thing that puts a human on an undeliverable legal notice, is
gated on `smsBlocked` (line 320) — an opt-out — and never fires for "no
address at all," which is the commoner and worse case. The result is an
evidence trail that says we notified somebody we did not, which in front of
a judge is the one thing worse than a gap. Fix: `no_address` on a locked
category raises the same Task as `sms_opt_out`; `PORTAL` is not a delivery
for a recipient with no credential that reaches the portal; and a "cannot be
reached electronically" queue that produces the printable to post on the
door, which R-062's document generation already does.

### 6. Twenty scheduled jobs now carry legal clocks and nothing reads whether any of them ran · (c) · M · PRD §6.5/§6.6, R-006 — made load-bearing by R-158/R-159/R-163

`JobRun` rows are written by `apps/web/lib/jobs/runner.ts:128` and updated
at line 173. A case-insensitive grep for `jobrun` across `apps/web` returns
exactly three non-test consumers: the writer, the cron route's audit row,
and the digest job reading its own last run. **No screen, no Task, no
notification, no alert reads job health.** Three compounding behaviours: a
failed run is deliberately not retried ("a retry is a deliberate act (clear
the row)", line 158) and there is no surface from which to clear a row; a
missed *day* is never caught up, because `runDueJobs` only ever computes
today's business date; and the `attempts` column is never incremented by
anything. The cron route writes a `job.failed` audit row whose own comment
says "a nightly job that failed silently is how a month of missing late
fees happens" — and then leaves it where nobody looks. This was survivable
when the jobs were late fees and MTM rollovers. It is not now:
`deposit.disposition_reminder`, `evictions.court_date_reminders`,
`cases.stalled` and `billing.sweep` are the four things standing between the
owner and a missed statutory deadline, a defaulted hearing, and an unwatched
fair-housing clock. Fix: a job-health panel on `/money` or the dashboard
(last successful run per job, anything failed or not-run-today), a `Task`
on a failed run, a re-run control, and a bounded catch-up for a missed
business date.

### 7. There is no payment plan, and the payment plan is how a small landlord avoids filing · (b) · M–L · PAY-08/PAY-12, RISK

Grepping `paymentPlan|arrangement|installment|promiseToPay` across schema,
core and app finds one thing: a *free-text example* in a refusal message —
`'A short note — "agreed a payment plan", for example.'`
(`apps/web/lib/payments/collection.ts:53`). A repayment agreement in this
product is a `halt_dunning` hold with a sentence typed into it. There is no
schedule of expected instalments, no signed document, no "broke the plan on
the second payment" trigger, no rent-roll state between *current* and *past
grace*, and no way for the next person to see whether the tenancy is on
plan and keeping to it. Every 10–50 door operator runs several of these a
year and each one is the decision that avoids a filing fee, an attorney and
a month of vacancy — and each one is currently held in the owner's head plus
a note nobody queries. It is also a fair-housing surface with none of the
guardrails PAY-04 already built for waivers: who was offered a plan and who
went straight to a notice is a disparate-treatment pattern, and the waiver
report (`apps/web/lib/ledger/waiver-report.ts`, correctly covering
LATE_FEE/NSF_FEE and correctly reporting the un-forgiven tenants too) has no
equivalent here. Fix: a `PaymentPlan` with instalment dates and amounts, a
hold that references it rather than a free-text reason, a break condition
that raises a `Task` and lifts the hold, and the plan's status on the
rent-roll row.

### 8. Nothing re-keys the house at move-out, and the departing tenant's door code stays live · (a) · M · LEASE-12/PROP-04, R-072's own "re-key, logged"

`markTurnoverRentReady` (`apps/web/lib/turnover/actions.ts:78-108`) flips
the unit `MAKE_READY → VACANT` and requires nothing — its own comment
defends not requiring open punch-list items closed, which is right, but the
re-key is not a punch-list item, it is the one thing that must be true
before a stranger gets keys. `TurnoverStage.REKEY` exists only as a label a
PM may or may not put on a work order (`packages/core/turnover/stages.ts`,
whose comment says plainly "not a hard sequence anything enforces").
Separately, the only code in the product that retires an `AccessCode` is
`apps/web/lib/confidential/actions.ts:380-390` — R-091's safety-case path.
`changeLeaseStatus` ending a tenancy touches `AccessCode` not at all. So on
an ordinary move-out the previous tenant's keypad code remains active, is
still revealable to vendors through `revealAccessCode`, and appears on
R-092's handoff packet. The exposure is the one that ends careers: a former
tenant walks back in, and the operator's own audit log shows the code was
never retired and the re-key was never recorded. Fix: retire live
`AccessCode` rows in the same transaction that ends the tenancy; a re-key
work order auto-created with the turn; and rent-ready warns-and-overrides
with a reason when no re-key is recorded (R-027's posture, never a hard
block).

### 9. Half of all intake never reaches the troubleshooting script that exists to stop truck rolls · (a) · M · MAINT-01/MAINT-02, R-019/R-021/R-022

`applicableTroubleshootingSteps`
(`packages/core/maintenance/troubleshooting.ts:96`) is genuinely good work —
seven scripts, GFCI-in-another-room called out by name, illustrations,
TRIED/DECLINED logged before dispatch is allowed. Its only consumers are
`maintenance-wizard.tsx` and the validator that backs it.
`apps/web/lib/comms/sms-intake.ts:154-171` opens a ticket at
`category: 'UNCATEGORIZED'` with no prompts, no troubleshooting, no photo
and — the file's own comment concedes it — no category to hang a script on.
`logStaffTicket` (`maintenance/actions.ts:627`) does the same for the phone
call. R-021's own backlog row says "roughly half of real requests arrive
this way." So the deflection machinery is reachable only from the channel
the fewest tenants use, and the two channels that carry the non-digital
tenant and the 11pm text — the two where a wrong dispatch actually costs a
truck roll — get none of it. Fix: the SMS intake replies with one link into
the wizard's clarify-and-troubleshoot steps pinned to the ticket it just
opened (R-032c's tokenless-link pattern already exists and already solves
the "she is not signed in" problem), and the phone-logged form runs the
same script on screen so the PM reads it to the tenant.

### 10. The turn is a label on a work order, not a sequenced project · (a) · M · LEASE-12, RPT-05

`TurnoverProject` (`schema.prisma:4793`) is a unit, a lease, a target date,
a rent-ready timestamp and a bag of `WorkOrder`s. Nothing creates a standard
turn: `draftPunchListFromInspection` produces one work order per
POOR/DAMAGED/MISSING inspection item with `turnoverStage: null` and leaves
staging to a human, and there is no template, no sequence, no dependency, no
per-stage target, and no stall detection — R-158's new `cases.stalled` sweep
covers five case types and a turn is not one of them. The consequence is the
one that costs the most per occurrence: a turn where the floor guy cannot
start because the paint is not done, and nobody notices for six days, is
invisible to every screen in this product. The only signal is `daysVacant`,
which finding 4 shows is broken. Fix: a turn template (trash-out → repairs →
paint → floors → clean → re-key) instantiated at
`startTurnoverProjectForLease` with per-stage day targets against
`targetRentReadyDate`, the next stage blocked-or-warned on the previous, and
a `cases.stalled` check for a turn with no work-order movement in N days.

### 11. The chase goes to one tenant, is a manual press, and there is no ladder · (a)(c) · M · PAY-06/PAY-07, COMM-03

`apps/web/lib/payments/reminders.ts:140` picks the recipient with
`lease.leaseTenants.map(...).find((t) => t.active)` — **the first active
tenant, singular**. On a roommate lease only one person is ever chased, and
the roommate who is actually holding the money hears nothing; on a
co-signed tenancy the guarantor hears nothing either, which R-165's entry
names as deliberate scope ("the backlog line asked for the *demand* ladder,
not the reminder one"). And the whole thing is a batch press on the rent
roll: there is no entry in `SCHEDULED_JOBS` for delinquency at all, so
unless a human opens `/money/rent-roll` and presses a button, nobody is
chased on any day. The aged buckets are right, the holds are right, the
notice-and-hold interlock R-156 built is right — and the trigger between
"past grace" and "somebody serves a notice" is a person remembering. The
tenant who goes quiet on day 12 is exactly the tenant nobody presses the
button for. Fix: address every active tenant and every active guarantor on
the lease; a scheduled job that raises a `Task` (never an auto-send — the
press stays deliberate, D-9's queue is the right home) at named days past
grace, and a per-tenancy record of what was sent when so the ladder itself
is evidence.

### 12. Three LLCs collect into one bank account and nothing tells the owner whose money is whose · (b) · M (cheap) / L (full) · PROP-02/RPT-05/RPT-07, D-11

`LegalEntity` (`schema.prisma:455-485`) has a name, a type, an agent and
three approval thresholds. It has no funds destination of any kind, and
there is one `STRIPE_SECRET_KEY` for the deployment
(`apps/web/lib/billing/provider.ts:23`) with no `stripeAccount`,
`on_behalf_of` or `transfer_data` anywhere in the tree. So every dollar of
online rent for every property in every LLC settles into a single Stripe
balance and a single bank account. The entity boundary this product
otherwise takes seriously — R-081a's operating snapshot, R-081b/d's tax
packet, D-123's one-LLC-per-property, D-168 making R-166's *offline* deposit
slips entity-bounded because "two properties under one LLC share a bank
account and two different LLCs cannot" — stops precisely at the money.
Commingling is the specific thing an LLC structure exists to prevent, and
the operator finds out about it from an accountant in April or from an
opposing attorney. The full answer (an account or a connected account per
entity) is a decision, not a row. The cheap answer that should ship first
and is genuinely valuable on its own: a per-entity settlement report — what
settled, for which entity's properties, in a date range, reconcilable to a
bank line — so the owner can move the funds deliberately and prove they
did. **Needs counsel** before the full version; this is a legal-structure
question, not a payments question.

### 13. A tenant who reports a problem hears nothing back at all · (a) · S · MAINT-01/COMM-03, NOTIF-01

The template registry (`packages/core/notifications/templates.ts`, 40 keys)
has `workorder.vendor_dispatch`, `workorder.verify_request`,
`entry.notice`, `maintenance.emergency` — and no acknowledgment of any kind
that a request was received. Grepping `notify(` in `maintenance/actions.ts`
finds exactly one call, the emergency page to staff; `sms-intake.ts` and
`email-intake.ts` contain none. So a tenant who texts "toilet won't stop
running" at 11pm gets silence until a vendor is dispatched, which may be
Thursday. The portal wizard at least renders a confirmation screen; the SMS
and phone paths — the ones this product deliberately built to serve the
non-digital tenant — produce nothing the tenant can see. This is the
cheapest finding here and it prevents the most expensive downstream thing:
the second text, the third text, the "nobody ever responded" message that
becomes the first line of a habitability letter, and R-055's retaliation
window opening on a complaint the owner never knew was escalating. Fix: one
template, sent on `ticket.created` from every intake path, carrying the
reference and what happens next; one more when the job is scheduled.

### 14. Every statutory deadline is calendar days with no weekend or holiday roll, and the config cannot say otherwise · (a) · M · PRD §6.7, D-4 — R-162's second state

`JurisdictionRule` carries eighteen day-count and money fields and no field
describing *how days are counted*. `addBusinessDays`
(`packages/core/scheduling/local-time.ts:303-310`) — despite its name —
adds plain calendar days and returns whatever date lands, weekend or public
holiday. Every clock in the product runs on it: the deposit disposition
deadline, the cure clock, the notice periods, the rent-increase notice, the
abandonment periods, the accommodation response window R-158 now escalates
on. Several states count notice periods in *business* days, and several
roll a deadline landing on a Saturday or a legal holiday to the next
business day. D-4 is categorical that a number a legislature can change is
configuration; how that legislature counts to thirty is the same kind of
fact and there is nowhere to put it. This did not bite while Texas was the
only configured state — but R-162 was built specifically so a second state
can be added without a seed script, and the second state is where a
calendar-day assumption becomes a wrong deadline nobody can see. Fix: a
`dayCountBasis` (calendar / business) and a `rollForwardOnNonBusinessDay`
flag per rule, a holiday list the rule references, and one shared deadline
function every clock calls. **Needs counsel** per state before any of it is
made effective — the existing legal-review release gate (flagged-gaps §6)
covers it.

### 15. Deposit escrow and interest are two sentences on a screen · (c) · S · PAY-11/INSP-05

`depositObligations` (`packages/core/ledger/deposits.ts:145-161`) turns
`depositEscrowRequired` and `depositInterestRequired` into the strings "Must
be held in a separate account from operating funds." and "Must earn
interest for the tenant." — and that is the entire implementation.
`Deposit.escrowAccountRef` is nullable and written by nothing;
`Deposit.interestAccruedCents` defaults to 0 and is incremented by nothing;
there is no rate on `JurisdictionRule` and no accrual anywhere. For Texas
this costs nothing, which is why it has survived. It is a live trap for the
second state: the disposition letter would owe interest it cannot compute,
the letter goes out short, and a short disposition is the fact that
converts a routine deduction dispute into a statutory penalty claim.
Cheapest honest fix is to make the gap loud rather than to build accrual —
R-162's coverage screen already names states with unresolved legal fields,
and "this state requires deposit interest and this product does not compute
it" belongs on it, blocking that state's rule from going effective until
somebody decides.

## Do not build

- **A settings screen for the turn-stage day targets, the chase ladder days,
  or the case-stall thresholds.** Same reasoning the last review gave and it
  has held: these are house rules, not statutes. D-4 governs numbers a
  legislature can change. Named constants with the reasoning beside them,
  exactly as R-158's `ABANDONMENT_QUIET_STALL_DAYS` does.
- **Stripe Connect, yet.** Finding 12's cheap half — a per-entity settlement
  report — delivers most of the value for a fraction of the work and is
  reversible. Connected accounts change every payment path in the product
  and need an answer to a legal question nobody has asked yet.
- **Backfilling the doubled `Payment` rows from finding 3.** Same call the
  owner made on R-038a and it was right then: fix the writer, report the
  historical duplicates, and leave money already reconciled alone. The
  corrective write has a bigger blast radius than the bug.
- **A second work queue for job failures.** Finding 6 wants visibility and a
  nudge; both belong in `Task` and on an existing screen. D-9 has now been
  paid for twice.
- **Deposit interest accrual.** Finding 15's fix is a warning, not an
  engine. Build the engine the week a property in an interest state is
  actually onboarded, not before.
- **Chasing D-171 from a laptop.** Its own entry is right — reproducing a
  CI-contention race needs the CI environment. If it is worth an item, the
  item is "reduce mobile-chrome worker concurrency and re-measure," not
  "debug the intercepting element."

Files worth reading first, if this becomes a backlog:
`apps/web/lib/leases/deposit-disposition-start.ts`,
`apps/web/lib/deposits/actions.ts`, `apps/web/lib/dashboard/queries.ts`,
`apps/web/lib/evictions/queries.ts`, `apps/web/lib/turnover/queries.ts`,
`apps/web/lib/notifications/send.ts`, `apps/web/lib/jobs/runner.ts`,
`apps/web/lib/comms/sms-intake.ts`, `apps/web/lib/turnover/actions.ts`,
`packages/db/prisma/schema.prisma`.
