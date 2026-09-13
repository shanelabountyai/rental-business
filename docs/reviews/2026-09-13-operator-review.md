# Operator review — 2026-09-13

Source for the Arc 5 backlog rows, per D-164, D-172 and D-201's precedent.
Produced by the rental-operator agent reviewing the shipped product after
R-204 closed the Arc 4 backlog. Fifteen findings, ranked by operational pain ×
frequency; ten are behaviour that is **wrong**, not missing. Category key:
**(a)** gap in what shipped · **(b)** new capability · **(c)** recorded debt
now load-bearing.

Three notes that are not findings. **CI is green and was checked, not copied**:
`gh run list --limit 5` shows R-200 (`34660946450`), R-201 (`34698000567`),
R-202 (`34702228353`), R-203 (`34712140082`) and R-204 (`34726068479`) all
`completed success`; `34726068479` is on `14c7be8`, the Arc 4 head. The
`leases.spec.ts` cleanup flake the last review flagged is genuinely closed by
R-202/D-217. **Arc 4 fixed all fifteen of the last review's findings at the
writer, and the verification discipline improved again** — eleven of the
eighteen items proved their new assertion against the reverted fix (D-197),
which is why this review had to go looking in new places rather than
re-checking old ones. **Two things in `NEXT.md` I judge deliberate and would
leave alone**: no staff withdraw for a signing request (nobody has asked), and
`LeaseSignerStatus.DECLINED` having no writer (the sign page offers sign or
leave, which is the right shape). **One I checked and could not confirm**:
`businessDaysBetween` in `packages/core/scheduling/local-time.ts:315-321` reads
like a weekday count and is in fact plain calendar arithmetic, so `daysToFill`
is correct. The name is a landmine and the third reader will get it wrong; that
is a comment, not a row.

## Verdict

Arc 4 did what Arc 3 asked of it, and the quality of the reasoning is now the
best thing about this codebase: `paidTowardPlan` nets the charges, the deposit
clock watches the money rather than the letter, the caught-up job replays the
day with that day's clock, a closed flag no longer silences a live condition,
and the Task queue finally reaches nineteen subjects instead of three. The
shape is right and the evidence trail is genuinely better than most production
systems.

What Arc 4 did not touch is the arithmetic underneath the two screens an
operator lives on. **Arc 3's defects were automated decisions that were
silently wrong; Arc 4's — the fourth class — are the money numbers themselves
being computed off the wrong base, everywhere the ordinary monthly rent is
involved.** D-11/D-40 decided that the subscription's rent line mints no
`Charge` row. Three separate readers were then written against the `Charge`
table as if it were the debt list, and all three are wrong in the normal case:
the late-fee job charges nothing at all on any lease that started mid-month,
charges a percentage of the entire arrears on the ones that did not, and the
delinquency aging anchors to whichever charge row is oldest the moment a second
month goes unpaid. The single most consequential gap: **`assessLateFees`'s
second pass excludes any lease carrying a `type: 'RENT'` charge, and every
mid-month move-in gets one at activation — so on those tenancies no late fee
has ever been assessed, for the life of the lease, and the job reports
SUCCEEDED every night.**

## Findings

### 1. WRONG — A mid-month move-in means no late fee is ever charged; a first-of-month one means the fee is a percentage of the whole arrears · (a) · M · PAY-04/D-4/D-12, R-040/R-042/R-118

Two halves of one root, both provable from four lines.
`LATE_FEE_APPLIES_TO = ['RENT']` (`apps/web/lib/ledger/late-fees.ts:68`).
Pass 1 assesses per dated RENT `Charge`; pass 2 — the one that exists because
ordinary rent mints no charge row — selects
`charges: { none: { type: { in: [...LATE_FEE_APPLIES_TO] } } }` (`:306`).

**Half one.** `chargeMoveInProration` writes `type: 'RENT'` with
`dueOn: lease.startsOn` (`apps/web/lib/billing/proration.ts:107-121`, and its
own comment defends the type), called from `provision.ts:220` at activation.
So **any lease that did not start on its rent due day carries a RENT charge for
ever, and is excluded from pass 2 for ever.** Pass 1 then reaches that
proration, finds `outstandingCents <= 0` because it was paid on move-in day,
and `continue`s (`late-fees.ts:245`). Net: the tenancy's ordinary rent is
assessed by neither pass. A tenant who pays fifteen days late every month for
three years is charged nothing, on every one of those leases, and `/jobs`
records `ledger.late_fees` SUCCEEDED with `chargesAssessed: 0`. On a
twenty-door portfolio where half the leases started mid-month and a 5% fee on
$1,500 is $75, the fees that should have been assessed at a 30% monthly
lateness rate are roughly **$225/month — $2,700 a year — that the ledger has
never once asked for**, plus the deterrent, which is most of the point.

**Half two, the mirror.** For a lease that *did* start on the due day, pass 2
fires — and passes `outstandingCents: delinquency.balanceCents`, the whole
ledger balance (`late-fees.ts:352-357`). `PERCENT_OF_RENT` then computes on
that (`packages/core/ledger/late-fee.ts:163-171`, summary string *"5% of the
outstanding balance"*). One month unpaid at $1,500: $75, correct. Two months
unpaid at $3,000: **$150** — double the lawful monthly rate — for being late on
one month's rent. Three months plus the prior fees: 5% of $4,725 = $236,
clamped only if `lateFeeMaxCents`/`lateFeeMaxPercentBps` is configured, which is
nullable. That is a fee computed partly on previously assessed fees, which
several states bar outright and which is the first thing a tenant's attorney
tests. **Needs counsel** on whether a percentage fee may lawfully take arrears
rather than the period's rent as its base; either way the two passes must not
disagree with each other, and today they do. Fix: derive the rent period debts
from the `LedgerEntry` CHARGE rows (see finding 2 — they exist, dated, and are
already loaded), assess per period, and make `monthlyRentCents` the base for a
percentage.

### 2. WRONG — On the day a second month of rent goes unpaid the aging anchor jumps to the oldest charge on file, and the chase ladder goes permanently silent · (a) · M · PAY-06/RPT-02, R-044/R-118/R-179 (D-189)

`oldestUnsettled` (`packages/core/ledger/aging.ts:221-238`) builds the debt
list as *the `Charge` rows plus one month's rent dated `nearestRentDueOn`*,
allocates the balance newest-first, and then:

```ts
return unallocatedCents === 0 ? owed[owed.length - 1]!.debt.dueOn : newestFirst[newestFirst.length - 1]!.dueOn
```

The second branch is reached whenever the balance exceeds one month's rent plus
the charges — which is exactly what two unpaid months means. Worked, with the
same lease as finding 1: move-in 15 Jul 2025, a $726 "Part month" proration
paid on time; rent $1,500 on the 1st; nothing paid since February. As of
20 May 2026 the balance is $4,500. Debts newest-first: `[2026-05-01 $1,500,
2025-07-15 $726]`. Allocate 1,500, then 726, `unallocatedCents = 2,274 > 0` →
the anchor is **2025-07-15**, a charge this tenant paid on time ten months ago.
`daysLate` comes back **309**, not 49. That is the R-118 defect returning
through the fallback branch, and it is now on the tenancy that matters most.

Three consequences, and the third is the expensive one. The rent roll prints
*"1 Jul 2025"* as the oldest unpaid date beside this tenancy
(`apps/web/lib/payments/rent-roll.ts:231-249`), which is the date somebody will
read out in a hearing. The report sorts `b.daysLate - a.daysLate`, so this
tenancy pins the top of the list above genuinely older arrears. And
`chaseRungDue` matches days past grace **exactly** against `[1, 5, 15]`
(`aging.ts:340-344`) — at 309 days late nothing ever matches again, so
R-179's ladder, the whole point of which is that somebody hears from us before
a filing, fires **zero** times for the tenancy two months behind. The opposite
case is just as wrong: a lease with no charge history at all (no proration, no
fee) reports two unpaid months as 19 days late, so the `30+` bucket on the
delinquency tile is empty on a portfolio full of 60-day arrears. The fix needs
no schema change: `invoice.finalized` already projects one dated `CHARGE`
`LedgerEntry` per period (`packages/core/billing/events.ts:293-318`,
`apps/web/lib/billing/webhook.ts:340-355`), and `rentRoll` already loads those
rows for `balanceCents` (`rent-roll.ts:155-163`). Age from them. Mapping
`occurredAt` (the finalize instant) to the period's due date needs care and
should be written down.

### 3. WRONG — An emergency vendor dispatch between 9pm and 8am is held until morning, and the screen says it went · (a) · S · MAINT-03/NOTIF-05, R-020/R-025/R-029

`EMERGENCY_CATEGORIES` contains exactly one member —
`maintenance_emergency` — and `bypassesQuietHours` reads only that set
(`packages/core/notifications/categories.ts:302-307`). The vendor dispatch
sends on `work_order_assigned` (`apps/web/lib/workorders/actions.ts:407-422`),
supplies `propertyId`, and therefore gets `deferUntil = quietHoursEndAfter(...)`
(`apps/web/lib/notifications/send.ts:180-193`), status `DEFERRED`
(`:307-309`). The drain only picks up `{ status: 'DEFERRED', sendAfter: { lte:
now } }` (`:605`), so the immediate `dispatchPendingNotifications` call right
after cannot send it. Default quiet hours are 21:00–08:00
(`packages/core/notifications/quiet-hours.ts:32`) — **eleven hours**.

The scenario is the one this product was built for and it is now broken end to
end. A tenant reports a sewage backup at 22:40. `maintenance_emergency` pages
the on-call PM correctly — that category bypasses. The PM gets up, opens the
work order, assigns the 24-hour plumber, and the page returns its success
notice. **The plumber's text is scheduled for 08:00.** Nothing on the screen
says so; `priority: 'EMERGENCY'` is right there in the notify context and
nothing reads it. Cost: nine hours of a sewage backup or an uncapped supply
line is a category of habitability claim, a mould remediation and an insurance
deductible, not a truck roll — call it $4,000–$25,000 on one event, against a
one-line fix. `reissue.ts:105` has the same shape. Fix: bypass quiet hours when
the work order's priority is EMERGENCY (or when the recipient is a VENDOR at
all — a vendor is a business being dispatched, not a consumer being marketed
to), and say on the screen when a send was deferred.

### 4. WRONG — Nothing creates a move-in condition report, nothing notices its absence, and the job that claims to escalate a missing one cannot fire · (a) · M · INSP-01/INSP-02, R-068/R-069/R-074

A `MOVE_IN` inspection is created in exactly one place: a staff member pressing
the button on the inspections form
(`apps/web/lib/inspections/actions.ts:85,130`). Lease activation does not
create one. `lease.deposit_cleared` raises a Task that says *"Move-in funds
cleared — release access codes"*
(`apps/web/lib/leases/deposit-clearing-job.ts:103-111`) and says nothing about
a walk. `Lease.moveInAt` is written by finishing the walk (D-178), so a
tenancy with no walk simply never gets one, and R-172's days-vacant clock never
stops either.

The job that looks like the safety net is not one.
`inspection.move_in_overdue` selects
`{ type: 'MOVE_IN', selfGuided: true, performedAt: null }`
(`apps/web/lib/inspections/auto-finalize-job.ts:122-130`) — **it needs a row to
exist before it can complain that nobody walked it.** No row, no escalation,
ever. The asymmetry is provable in two filenames:
`pre-move-out-scheduling-job.ts:78` creates its inspection automatically;
there is no move-in equivalent.

What that costs is the entire deposit case. `move-out-copy.ts:39` builds the
side-by-side from `{ leaseId, type: 'MOVE_IN' }`; with none, R-070/R-151's
comparison screen — the feature this product is proudest of — has nothing on
the left. Every deduction then trips `isUnsupportedDeduction`
(`packages/core/ledger/disposition.ts:95-105`), and the operator is standing in
front of a judge with photographs of damage and nothing to prove the house was
not already like that. On a $2,000 deposit in a state with a penalty provision
this is the $2,000 plus a multiple plus fees. **Needs counsel** on the penalty,
not on the gap. Fix: raise the MOVE_IN inspection on lease activation (blank,
`selfGuided` per the tenant's arrangement) so the existing overdue job has
something to watch, and refuse — or at minimum loudly warn on —
`markTurnoverRentReady`'s sibling, the access-code release, while no move-in
report exists.

### 5. WRONG — The deposit applied to arrears never reaches the ledger, so the tenancy still shows the whole balance after the letter says it is settled · (a) · M · PAY-07/PAY-11/INSP-05, R-071/R-170, D-11

`computeDisposition` sets `appliedCents = min(heldCents, deductions +
outstandingLedgerCents)` (`packages/core/ledger/disposition.ts:52-56`).
`finalizeDisposition` writes that number onto the `Deposit` row and into the
letter (`apps/web/lib/deposits/actions.ts:284-292`) — and writes **no ledger
entry at all**. A grep for a credit posting on the disposition path returns
nothing; the only thing that ever moves a balance is the Stripe webhook.

So: tenant moves out owing $1,500 in rent with a $1,500 deposit held. The
letter correctly says the deposit was applied and nothing is refunded. The
`Deposit` liability is released (`disposition.ts:208-232` keys the release on
`dispositionSentAt`). And the tenancy's `balanceCents` is **still $1,500**, for
ever, because no PAYMENT or CREDIT entry was ever projected. Four readers are
now wrong and they disagree with the letter the tenant is holding: the lease
page's balance, `statementForPeriod` (the statement a former tenant can ask
for, and the one that goes in R-083's attorney packet), the operating report's
income side, and anything the operator hands a collections agency. Two books,
one event, and the one that says $1,500 is the one somebody will act on —
demanding money that was already taken out of the deposit is the fact pattern
that turns a clean move-out into a counterclaim. D-11 governs the fix and does
not block it: the deposit application is money that satisfied a receivable, so
it goes to Stripe as a credit (the `waiveCharge` path at
`apps/web/lib/ledger/waivers.ts:118-140` is the shape) and comes back as a
projected entry. **Do not backfill** — report the affected deposits, fix the
writer, per the standing rule.

### 6. WRONG — A `Notice` records service the product never proved, on the one channel the tenant may not be able to reach · (a) · M · COMM-02/LEASE-11/PROP-04, R-027/R-051/R-061/R-157, extends D-179

Five call sites stamp `serviceMethod: 'PORTAL', servedAt: now` plus a
`NoticeDelivery` row plus a `notice.served` audit row, unconditionally, inside
the transaction, before anything is sent: work-order scheduling
(`apps/web/lib/workorders/scheduling.ts:186-243`), inspection scheduling
(`inspections/scheduling.ts:188,213`), showings (`showings/actions.ts:126,142`),
lease actions (`leases/actions.ts:857,881`) and chargebacks
(`workorders/chargeback-actions.ts:213`). The comment in the first defends it:
*"an entry notice is delivered to the portal by the product itself, so there is
no operator choice to check."* That is the exact reasoning R-173 overturned for
notifications — **D-179: a portal is not an address unless the person can get
into it** — and the fix was scoped to `NotificationDelivery` and never reached
the `Notice` table.

It is not a theoretical gap. `deliverAuthLink` sends on `account_access`, which
is **EMAIL only** by construction (`apps/web/lib/auth/delivery.ts:33-36`,
and `recipient` carries only an `email` at `:92-96`). A tenant with a phone and
no email address therefore *cannot sign in at all* — see finding 12 — and the
product records a 24-hour entry notice as served to them through that portal.
There is also no `lastSignedInAt` anywhere on `Tenant`
(`packages/db/prisma/schema.prisma`, model `Tenant`), so the claim is not even
falsifiable after the fact. An unlawful-entry or lockout claim is argued
entirely off that timestamp.

Same class, different channel: the FCRA adverse-action notice writes
`serviceMethod: 'EMAIL', servedAt: now` inside the transaction
(`apps/web/lib/screening/staff-actions.ts:181-186`) and the actual send is a
`try/catch` afterwards whose failure branch is one `console.error`
(`:231-233`). A declined applicant whose email bounced is recorded as served.
Fix: record what the engine actually did. Service by PORTAL should require the
recipient to have a working sign-in path (and ideally a read receipt —
`markNoticeRead` already exists and is the honest evidence); service by EMAIL
should be written from the delivery outcome, not from optimism.

### 7. WRONG — A suppressed notification is reported to the operator as sent, and 36 of 39 callers never look · (a) · S–M · NOTIF-01/NOTIF-05/COMM-04, R-016/R-173/R-196

`notify()` returns `ChannelOutcome[]` carrying
`status?: 'QUEUED' | 'SUPPRESSED' | 'DEFERRED'` and a `reason`
(`apps/web/lib/notifications/send.ts:87-100`), and its own header explains that
a suppressed row is *"most of the value of the table."* Thirty-nine modules
call it. **Three read the status** — `plan-actions.ts:261`, `messages.ts:152`,
`announcement-actions.ts:186`. The rest treat "the call returned" as "it went."

The sharpest instance is the rent chase. `sendReminders` does
`sentTo.push(party.id)` immediately after `notify()` with no test of the
outcome (`apps/web/lib/payments/reminders.ts:196-222`), then writes
`message.bulk_sent` with `sent` and `sentToPeople` counts and a `skipped` list
that only ever contains template failures (`:236-253`), then tells the operator
*"Reminder sent to 3 people on 2 tenancies"* (`:262-274`). A guarantor with no
recorded TCPA consent (D-190/D-211 — correctly suppressed), a tenant who
texted STOP, a recipient with neither email nor phone, and anyone inside quiet
hours are all counted as reached. The append-only `Notification` table says
SUPPRESSED; the audit row a PM or an attorney reads says sent. **Two
contradictory records of the same event inside one product, and the wrong one
is the one on the screen.** The same lie is on `workorders/scheduling.ts:315`
(*"Scheduled, and the tenant has been told"*) and on every entry-notice and
showing path. Fix: count `QUEUED`/`DEFERRED` as sent and everything else as
skipped-with-a-reason, at the shared helper rather than at 39 call sites; the
`plan-actions.ts:278` sentence — *"Not sent to X — no email or phone we may
use; give them a copy yourself"* — is the model and already exists.

### 8. WRONG — The retaliation guard is off the renewal path, which is how nearly every rent increase actually reaches a tenant · (a) · S · RISK-06, R-055/R-065

`retaliationCheckFor` has exactly two callers, both in
`apps/web/lib/leases/actions.ts`: a direct rent raise on the lease edit form
(`:355-362`, gated on `after.rentCents > before.rentCents`) and a
landlord-given notice to vacate (`:775-782`). `offerRenewal`
(`apps/web/lib/leases/renewal-actions.ts:101-145`) checks the statutory
increase cap and the notice period and **never asks the retaliation question at
all**. Opening an eviction case demands a written reason
(`apps/web/lib/evictions/actions.ts:78`) and likewise never checks the window;
neither does serving a notice through `/notices`, including R-194's cure
notice.

So the guard is armed on the path an operator uses by hand a few times a year
and disarmed on the path that produces almost every rent increase in a
portfolio — the 120/90-day renewal offer R-065 built to make renewals routine.
Concretely: tenant reports no hot water on 3 April, ticket is
`habitabilityFlag: true`, renewal offer with a $125 increase goes out 20 April,
and the product raises nothing. The direct-edit form would have refused without
a written reason. **That written reason is the entire defence**, and it is
exactly what does not get captured on the automated path. A retaliation
presumption in a state that has one shifts the burden onto the owner and can
convert a routine non-renewal into damages plus the tenant's fees. Cheap fix:
call the check from `offerRenewal` (increase only), from `openEvictionCase`,
and from cure-notice generation; the ack machinery and the audit action already
exist. Separately, and worth a line in the same row: the only signal the check
reads is `Ticket.habitabilityFlag`
(`apps/web/lib/leases/retaliation-check.ts:36-40`), so a tenant's
`AccommodationRequest`, a code-enforcement complaint or a written repair
demand that came in as an ordinary ticket open no window at all.

### 9. WRONG — Serving a cure notice stops nothing, so the demand is stale by the next morning · (a) · S–M · PAY-12/PAY-14, R-047/R-156/R-194 (D-209)

R-156's serve-and-hold is correct as far as it goes, but the hold it can place
is only the three payment switches — `blockOnline`, `blockPartial`,
`certifiedFundsOnly` (`apps/web/lib/notices/actions.ts:391-401`). None of the
seven `Hold` types carrying `halt_late_fees`
(`packages/core/holds/index.ts:100-150`) is placed by serving a notice or by
opening an eviction case; a grep for a writer of `halt_late_fees` outside the
late-fee job's own reader returns nothing. So the nightly `ledger.late_fees`
job keeps running against a tenancy under a served pay-or-quit.

Under a `DAILY` or `FLAT_PLUS_DAILY` rule the fee grows every night
(`packages/core/ledger/late-fee.ts:172-181`), and `postLateFeeDelta` tops it up
per business date. The notice froze `demandedCents` at generation (D-209). By
day three of a three-day cure window the ledger and the notice disagree by the
accrued daily fee, and the two screens say different things: `cureVerdict`
marks the tenant **cured** on `keptCents >= demandedCents`
(`packages/core/evictions/demand.ts:197`) while `/leases/[id]` still shows a
balance. In a state where a pay-or-quit must state the sum with precision, a
charge added after service is an argument the tenant's side gets for free, and
in a state where accepting a payment waives the notice the operator has now
been paid an amount that does not match what was demanded. **Needs counsel** on
whether post-service accrual defeats the notice. The product fix is small and
does not need counsel to start: a `notice_served` hold type carrying
`halt_late_fees`, offered on the same serve form that already offers the
payment switches, and the cure clock showing demanded-versus-ledger side by
side so the divergence is visible rather than inferred.

### 10. WRONG — A vendor who has never produced a certificate of insurance reads exactly like one whose COI is current, and nothing watches expiry · (a) · S · MAINT-11/RISK, R-079

`packages/core/vendors/dispatch.ts:131-132`:

```ts
w9Missing: !v.w9OnFile,
coiExpired: v.coiExpiresOn != null && v.coiExpiresOn < now,
```

The two lines are side by side and only one of them is right. A vendor with
`coiExpiresOn: null` — nobody ever asked, or they never sent one — comes back
`coiExpired: false`, so the assign dropdown
(`apps/web/components/workorders/assign-form.tsx:55`) and `/vendors`
(`app/(admin)/vendors/page.tsx:33`) render them identically to a vendor with
current cover. The W-9 case gets this right on the line above, which is what
makes it a defect rather than a design choice.

And nothing watches the date. There are `renter_insurance_expiring` and
`renter_insurance_lapsed` scheduled jobs for the *tenant's* policy (R-067) and
no COI equivalent anywhere in the job list, so a certificate that lapsed in
February is discovered in November by somebody opening the vendor record. The
exposure is not subtle: an uninsured roofer who falls, or who burns a house
down, lands on the owner's policy and then on the owner, and "we dispatched
them anyway" with the product's own record showing them clean is the worst
possible posture. It is also the strongest single argument against the LLC
separation the whole multi-entity design exists to protect. Fix: treat null as
missing and say so in the label; add a COI-expiry job on the same machinery as
the renter's-insurance one; consider a warn-and-log at dispatch rather than a
block, matching D-187's posture everywhere else.

### 11. Money owed by a tenant who has moved out leaves the product entirely · (b) · M · PAY-06/PAY-11/RPT-02

Three facts compose into one hole. `rentRoll` selects
`status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] }`
(`apps/web/lib/payments/rent-roll.ts:110`), as do the dashboard's delinquency
tile and `reports/queries.ts:179,213`; the `payments.chase` job runs off the
same function. `computeDisposition` produces `additionalOwedCents` — what the
tenant still owes after the whole deposit is applied — and its own comment says
collecting it is *"a separate, deliberately out-of-scope concern"*
(`packages/core/ledger/disposition.ts:26-29`). That number is rendered on
exactly one screen (`app/(admin)/leases/[id]/deposit/page.tsx:221-227`) and
in the letter's sentence *"We will contact you separately about this balance"*
(`disposition.ts:164-166`). There is no write-off, no bad-debt, no
collections-placement and no former-tenant surface anywhere in the schema.

So the moment the tenancy ends, the largest single receivable most small
portfolios ever book — unpaid final rent plus damage beyond the deposit,
routinely $2,000–$6,000 per bad exit — disappears from every list an operator
reads, from the aging, from "worst first", and from the chase. It survives only
as a sentence in a letter promising to be in touch. Over a 30-door portfolio
with three bad exits a year that is $6,000–$18,000 annually that the product
quietly stops tracking on the day it becomes real, and it is also the number
that decides whether to place with an agency, sue in small claims, or write it
off — a decision nobody can make from a screen that does not exist. Fix, in
value order: keep ENDED leases with a positive balance on their own aged view
(the arithmetic is already there); record `additionalOwedCents` as a real
receivable on that view rather than only in prose; add a write-off that is a
dated, reasoned, audited event rather than a deletion. Placement with an agency
and credit reporting stay out of scope (R-097b is vendor-gated).

### 12. A tenant or guarantor with a phone and no email can never sign in, and the product keeps recording deliveries to them · (a)(c) · M · ROLE-05/NOTIF-05/PRD §6.4's Gene test, R-003/R-139/R-173/R-196

`deliverAuthLink` is the only path any sign-in link takes, and it sends on
`account_access`, which is declared EMAIL-only with the reason written next to
it (`apps/web/lib/auth/delivery.ts:33-36`); the recipient it hands `notify()`
carries `email` and nothing else (`:92-96`). `tenant-magic-link` is the only
tenant provider wired in `auth.ts`. So a tenant with a phone and no email
address has no route into the portal at all — not a hard route, none — and the
same is true of a guarantor, which R-196 recorded as its own leftover after
building everything else about reaching them.

This is the persona the product keeps saying it is for. R-021's SMS-to-ticket,
R-177's SMS troubleshooting door, R-181's SMS acknowledgement and D-190's
consent work all exist because some long-term tenants will never log in — and
then the one thing they might need the portal for (their balance, a payment,
their lease papers, a notice served to them there) is closed. Finding 6 is the
compounding half: the product records entry notices as PORTAL-served to exactly
these people. R-173 taught the notification engine that a portal nobody can
enter is not a delivery; nothing taught the front door. Fix: allow the magic
link to go by SMS when that is the only address — the template and the Twilio
adapter both exist, and `account_access` is already LOCKED so no preference can
suppress it — or a staff-issued printed one-time code for a tenant who has
neither. Whichever way it goes, `reachableElectronically`'s predicate belongs
in front of every PORTAL service claim.

### 13. Nothing measures a habitability complaint against a repair deadline · (b) · M · MAINT-01/RISK-06/PRD §6.7, D-4

`detectHabitabilityLanguage` stamps `Ticket.habitabilityFlag` at every intake
door — portal, SMS, email, phone-logged
(`apps/web/lib/maintenance/actions.ts:206`, `comms/sms-intake.ts:169`,
`comms/email-intake.ts:138`). Downstream it does three things: raises the
suggested priority, titles the triage Task, and opens the retaliation window.
**It starts no clock.** `JurisdictionRule` carries `entryNoticeHours`,
`payOrQuitDays`, `leaseViolationCureDays`, `depositDispositionDays`,
`abandonmentPresumedAfterDays`, `retaliationWindowDays` and a dozen more — and
no repair-deadline field of any kind. Nothing anywhere asks how long a
habitability-flagged ticket has been open.

That is the one statutory clock in this product that runs against the owner
rather than for them, and it is the only major one with no machinery. In many
states a written tenant notice plus a failure to repair within a defined period
unlocks repair-and-deduct, rent withholding, termination, and statutory
damages — and this product is already holding the written notice, timestamped,
in an append-only table, which is precisely the evidence the tenant's side
needs and the owner's side cannot currently see coming. A no-heat ticket opened
on a Friday and sitting unassigned through a long weekend is the ordinary
version; the expensive version is a mould or sewage claim where the elapsed
time is the whole case. **Needs counsel** on the deadline and on what counts as
written notice — which is exactly why it is a `JurisdictionRule` field under
D-4 and not a constant. Fix: `habitabilityRepairDays` (and whatever
acknowledgement window counsel names) on the rule; the ticket carries a derived
due date; the existing window-watching job pattern plus R-191's cool-off raises
the Task at halfway and at overdue; `computeCoverage` names it as a
`productLimit` for any state that has not answered, which is D-195's shape.

### 14. There is no deposit-dispute packet, and the deposit case is the one a small operator actually ends up in court over · (b) · M · INSP-03/INSP-05/PAY-11, R-070/R-071/R-083's precedent

R-083 built the one-click attorney packet for evictions and did it properly:
case summary, statement of account, every notice with its proof of service, the
executed lease, the photographs, every excluded exhibit named on the index and
on the audit row (`apps/web/lib/evictions/packet.ts:24-52`, D-50). Nothing
equivalent exists for a deposit. A grep for `packet` across `apps/web/lib`
returns the eviction one, the tax one, the property handoff file and nothing on
the deposit path.

An owner-operator at this scale may file one eviction in three years and will
face a deposit claim most years, because it is the cheapest case a former
tenant can bring and the one where the burden sits squarely on the landlord.
What that claim needs is one file: the move-in condition report with its item
photographs and the tenant's signature, the move-out report beside it,
R-151's per-item comparison, each deduction with the work order or invoice or
inspection item it is linked to and the depreciation guidance that was applied
(`packages/core/ledger/disposition.ts:85-92`), the disposition letter, the
proof of service to the forwarding address, the refund payment record R-170
built, and the statutory dates. Every one of those rows exists; none of them
can be handed over as a document. Assembling it by hand is an afternoon per
case and reliably misses the depreciation reasoning, which is the part that
wins. The machinery is `renderBlocksPdf` + `appendPdfs` + `packetBlocks`, the
same three functions R-083 used, and the same D-50 rule about naming what could
not be included.

### 15. Nothing starts the marketing clock when a notice to vacate lands · (b) · S–M · LEASE-12/LEASE-01/RPT-01, R-056/R-167/R-178 (D-184)

R-178 made the turn a sequenced project and it is good: seven stages
(`packages/core/turnover/stages.ts:13-21`), real work orders, a stall sweep, a
cost roll-up (`apps/web/lib/turnover/queries.ts:149`). Every one of those
stages begins **after** the unit is empty. `createListing` has exactly one
caller, the staff form (`apps/web/lib/listings/actions.ts:74-107`); nothing in
`turnover/start.ts`, in the notice-to-vacate flow, or in the renewal
non-renewal path creates a listing, raises a listing Task, or mentions one.

Days vacant is the most expensive number in this business, and the thirty days
of notice are the only free days an operator ever gets — the window to
photograph, price, publish, and book showings against an occupied unit
(R-064 already handles the occupied-unit showing and its entry notice, so the
capability is built and simply never prompted). The product today turns a
thirty-day notice into a thirty-day head start it does not take: the listing
goes up when somebody remembers, typically after the turn, and every day of
that delay is one day's market rent. At $1,500/month that is $49 a day; a
week's slippage on six turns a year is **$2,058**, and two weeks on a
twenty-door portfolio with a 40% annual turnover is roughly **$8,200**. Fix is
small and needs no new entity: when a notice to vacate is accepted or a renewal
lapses into non-renewal, raise a `listing.prepare` Task dated on the notice
day, pre-fill the listing from the unit and the outgoing rent, and put
days-to-list beside days-to-fill on `/reports/leasing` so the cost of not doing
it is visible. Publishing stays a deliberate act; only the prompt is automatic.

## What this review structurally could not see

**Anything only a browser reveals.** R-204 crawled 236 staff routes at desktop
and phone width plus five portal sessions, and all eight defects it found were
invisible to the test suite; the eviction-packet one (D-221) was invisible to
every screen as well, because the value was correct on both screens that showed
it and wrong only inside a structured object passed through whole. This review
read code and schema. A finding of the shape *"the screen says something quietly
wrong"* is not reachable this way, and the next milestone still owes its D-28
walk.

**Anything gated on a real vendor API.** Screening, e-sign and credit reporting
all run against simulated adapters (PRD 00 §14, D-7), and D-27 requires the
simulator to keep its own state so the disagree-branches stay reachable — which
means every claim here about screening or e-sign is a claim about the
simulator's behaviour, not the provider's. R-093 and R-097b are vendor-gated for
the same reason and neither is a laptop item. Finding 6's adverse-action half is
the one place this bites: whether a real CRA's delivery confirmation would make
the `servedAt` stamp honest is **unknown** and only a signed relationship
settles it.

## Do not build

- **Stripe Connect / a connected account per entity.** Declined by three
  reviews and still right. R-198 recorded the transfer with its archived
  report, which is the reversible half; the full version needs a legal-structure
  decision nobody has taken.
- **Backfilling anything.** Finding 5's un-credited deposits, finding 1's
  never-assessed late fees, finding 2's mis-anchored aging. Report them, fix the
  writer, leave reconciled history alone. A corrective write against
  append-only tables has the bigger blast radius every time, and D-201 has
  already paid for this lesson.
- **A settings screen for `CHASE_LADDER_DAYS`, `TURN_STAGE_DAYS`,
  `PLAN_GRACE_DAYS`, `WALKTHROUGH_WINDOW_DAYS`, `CATCH_UP_BUSINESS_DAYS` or the
  case-stall thresholds.** Four reviews have now declined it. House rules with
  the reasoning beside them; D-4 governs numbers a legislature can change and
  none of these is one. Finding 13's repair deadline **is** one, which is the
  distinction.
- **A second queue.** D-9 has been paid for four times. Findings 10, 13 and 15
  all want the existing `Task` queue used, not another table.
- **Deposit interest accrual and escrow engines.** R-183 made the gap loud and
  that remains the shipped answer until a property in such a state exists.
- **Rewriting `businessDaysBetween`.** It is calendar arithmetic despite its
  name and every caller is correct today. Rename it if somebody is in the file
  anyway; do not spend a row on it.
- **A move-in inspection that BLOCKS occupancy.** Finding 4 wants the report
  created and its absence visible, not a gate that stops a family moving in on a
  Saturday because nobody pressed a button. D-187's warn-never-block posture is
  the right one here too.

Files worth reading first, if this becomes a backlog:
`apps/web/lib/ledger/late-fees.ts`, `packages/core/ledger/late-fee.ts`,
`packages/core/ledger/aging.ts`, `apps/web/lib/payments/rent-roll.ts`,
`packages/core/notifications/categories.ts`,
`apps/web/lib/notifications/send.ts`, `apps/web/lib/payments/reminders.ts`,
`apps/web/lib/inspections/auto-finalize-job.ts`,
`apps/web/lib/inspections/pre-move-out-scheduling-job.ts`,
`apps/web/lib/deposits/actions.ts`, `packages/core/ledger/disposition.ts`,
`apps/web/lib/workorders/scheduling.ts`, `apps/web/lib/screening/staff-actions.ts`,
`apps/web/lib/leases/renewal-actions.ts`, `apps/web/lib/leases/retaliation-check.ts`,
`apps/web/lib/notices/actions.ts`, `packages/core/vendors/dispatch.ts`,
`apps/web/lib/auth/delivery.ts`, `apps/web/lib/evictions/packet.ts`,
`packages/db/prisma/schema.prisma`.
