# Operator review — 2026-09-02

Source of the Arc 2 backlog rows (R-153–R-168), per D-164. Produced by the
rental-operator agent reviewing the shipped product after R-152 closed the
original backlog. Sixteen findings, ranked by operational pain × frequency;
five are behaviour that is WRONG, not missing. Category key: **(a)** gap in
what shipped · **(b)** new capability · **(c)** recorded debt now
load-bearing.

## Verdict

The shape is right and unusually so: the evidence trail is real (append-only
by trigger, service proof as a child table, three-valued jurisdiction
verdicts), collections are aged rather than summed, the vendor edge is a link
and not an app, and entity scope is a first-class filter on every screen.
What is missing is almost entirely **the second occurrence of a thing** — the
second state, the second lease term for the same tenant, the second case that
nobody reopened. The single most consequential gap: `/jurisdiction`'s own
edit form silently destroys nine statutory fields it does not render, so the
only supported way to change a statutory number is also the way to lose the
rest of the state's configuration.

## Findings

### 1. WRONG — Editing a jurisdiction rule silently wipes nine statutory fields · (a) · S–M → R-153

`apps/web/lib/jurisdiction/actions.ts:156-192` — `createRuleVersion` writes
only the fields `apps/web/components/jurisdiction/rule-form.tsx` renders. The
schema carries nine more that shipped code reads, and none is carried
forward:

| dropped | schema default | what breaks the moment the new version takes effect |
|---|---|---|
| `noticeServiceMethods` | `Json?` → null | D-48's "nobody has told us" for every service; `NoticeDelivery.permittedByJurisdiction` goes null, and R-083's cure clock **derives the premature-filing gate from that stored verdict** |
| `abandonmentPresumedAfterDays`, `belongingsStorageDays`, `belongingsNoticeDays` | null | D-92's one hard refusal fires — belongings disposal becomes impossible portfolio-wide |
| `leaseViolationCureDays` | null | violation cure clock reports "not configured" |
| `nsfFeePermitted` / `nsfFeeMaxCents` | `true` / null | the NSF cap disappears; an **uncapped** NSF fee starts posting |
| `cardSurchargePolicy` / `cardSurchargeMaxBps` | `NONE` / null | card surcharge silently switches off |

The owner hits this every time a statute changes or a number is corrected —
and the audit row records only `state`, `version`, `effectiveFrom`, so the
diff is invisible even afterwards. Fix: `createRuleVersion` spreads the
previous version's row and overlays the form's fields; the form renders the
missing nine (the service-method map wants its own sub-form). One test:
create v2 from a fully-populated v1 through the action and assert every
column is equal or deliberately changed.

### 2. WRONG — A renewed tenancy has no deposit, so no disposition clock ever starts · (a)(c) · M → R-154

`apps/web/lib/leases/renewal-actions.ts:156` copies `depositCents` as a
*figure* onto the successor lease and leaves the `Deposit` liability row on
the predecessor (D-54: a renewal is a new `Lease` row). Every downstream
reader keys off `lease.deposits`:

- `apps/web/lib/leases/deposit-disposition-start.ts:40` reads
  `lease.deposits[0]`, finds nothing, returns `no_deposit` — **no
  `dispositionDueOn`, no `deposit.disposition_due` Task, no statutory letter,
  no countdown**
- `apps/web/lib/leases/deposit-disposition-reminder-job.ts` filters on
  `dispositionDueOn`, which is never set — no reminders, no 50%-elapsed alert
- `apps/web/lib/payments/rent-roll.ts:226` sums `lease.deposits` — the rent
  roll prints `$0.00 deposit held`
- `getDepositForLease` shows the move-out screen "this lease holds no deposit"

R-128 found the $0.00 symptom in the demo and fixed it by *seeding Deposit
rows*, not by fixing continuity — so the defect is intact and the demo cannot
show it (no demo tenancy has renewed). Every tenant who renews once hits
this at move-out; in a 10–50 door book that is most of the good tenants, and
the deposit-defence epic is switched off for exactly the tenancies where the
deposit is largest. Fix: at renewal cutover, re-point the `Deposit` to the
successor (one writer, one place) — or make every reader follow
`renewedFromLeaseId` to the tenancy root; prefer the first. Assert
`startDepositDisposition` returns `started` on a twice-renewed lease.

### 3. WRONG — Nothing connects money arriving to a notice or an eviction case · (a) · M → R-156

Three separate holes, one operator consequence:

- `packages/core/evictions/cure.ts` has no concept of a payment. A partial
  payment landing during the cure window — portal, autopay retry, or cash at
  the counter — moves the case toward FILING with no warning anywhere.
- `apps/web/lib/notices/*` never touches `collectionPaused` /
  `certifiedFundsOnly`. Serving a pay-or-quit does not place a hold and does
  not prompt for one (R-047 left this open, R-083 did not close it).
- The payment-hold panel that *does* do the right thing (`legal-hold.ts` —
  pauses Stripe synchronously, revokes live pay-links) lives on the lease
  page, on a different screen, at a different moment, driven by memory.

The owner hits this on every non-payment case — a handful a year, each worth
a month's rent plus filing and attorney costs when the notice is waived.
Fix: (i) serving a `CURE_NOTICE_TYPES` notice offers the hold inline with the
switches pre-set and a one-press "serve and hold"; (ii) `cureClock()` takes
payments-since-service and the case page shows a red band naming amount,
date, channel, and that acceptance may waive; (iii) the packet's exhibit
index lists any such payment rather than omitting it. **Needs counsel** —
whether acceptance waives, and of what amount, is state law and belongs in
`JurisdictionRule`, not in code.

### 4. WRONG — `certifiedFundsOnly` is not enforced where cash and cheques are actually taken · (a)(c) · S → R-155

`packages/core/payments/offline.ts:167` `offlinePaymentDecision` checks
`blockPartial` and never `certifiedFundsOnly`;
`apps/web/lib/payments/offline.ts:48-60` does not even select the column. So
the switch that says *cashier's cheque or money order only* stops the
**online** rails (pay screen, pay-link page both read it) and permits a
personal cheque at the counter — which is then pushed to Stripe as an
out-of-band payment against the open invoice. Recorded as a known gap in
R-038a's entry and carried since. Same failure mode as finding 3 and cheaper
to close. Fix: add `certifiedFundsOnly` and the instrument (`input.channel`)
to `OfflineFacts`; refuse `OFFLINE_CHECK` and `CASH` with the existing
neutral-sentence pattern, permit money order / cashier's cheque. One core
test per instrument.

### 5. WRONG — Inspections enter occupied units with no entry notice · (a)(c) · M → R-157

`entryDecision` has exactly three callers: `showings/actions.ts`,
`abandonment/actions.ts`, `workorders/scheduling.ts`. **No inspection path
uses it** — not `periodic-scheduling-job.ts` (annual interior,
auto-scheduled), not `pre-move-out-scheduling-job.ts`, not manual
`startInspection`. R-073 named this and nothing owns it. The annual interior
walk is the one inspection that is *always* into an occupied unit, and the
one that generates the photos a later deposit case rests on — illegal-entry
and retaliation exposure, and it taints the evidence it exists to collect.
Fix: route inspection scheduling through the same `entryDecision` → generate
→ serve → log chain work orders use; the auto-scheduling job raises the
notice at scheduling time and the walk cannot be marked performed without one
(warn-and-override with a reason, matching R-027's posture, never a hard
block).

### 6. No import tooling of any kind — the switching cost is the product · (b) · L → R-168

PRD §6.8 calls this adoption-critical and no backlog row was ever written for
it. There are three CSV *export* routes and no import anywhere: no
tenants/leases CSV, no opening balances, no bulk document upload, no "start
clean from a date" mode. Thirty properties of history hand-keyed through
`/properties/new` and `/leases/new` is a fortnight of evenings, and D-11
means opening balances cannot simply be inserted into `LedgerEntry` (the
projection is built from Stripe). Fix, and it needs a decision before a row:
(i) CSV import for LegalEntity/Property/Unit/Tenant/Lease with a dry-run diff
screen and a per-row error report; (ii) opening balances as a **one-time
Stripe invoice per payer** so the projection stays honest under D-11, never a
direct ledger write; (iii) bulk document upload keyed by address + type; (iv)
a "history starts here" date per property that reports suppress before.
Deposits imported at a known-position status, not assumed. Split at least
(i)+(iii) from (ii).

### 7. Five case types have no sweep, and one of them is a fair-housing clock · (c) · M → R-158

R-087, R-088, R-089 and R-090 each closed with the identical sentence —
*nothing raises a Task and nothing sweeps* — and R-086's accommodation clock
is computed on render only. Twenty-three jobs are registered in
`SCHEDULED_JOBS`; none looks at a stalled case.

- **Accommodation / ESA request** past its response window: visible only if
  somebody opens the lease page. D-89 deliberately refuses to pause the
  clock when documentation is requested — correct, and it makes an unwatched
  clock worse. The top fair-housing complaint source in the PRD's own words.
- Abandonment case with attempts logged in week one and nobody back since.
- Violation case: photos in March, no service, cure clock silently expired.
- Insurance claim with no event for a fortnight — and the water-mitigation
  target is 24 hours.
- Lease party-change amendment unsigned for three weeks, with an unscreened
  person in the unit.

Fix: one `case-stall-job.ts` over the five models, per-type thresholds as
named constants with the reasoning beside them, raising the existing `Task`
type (D-9 — do not invent a queue). The accommodation clock gets escalation,
not a nudge.

### 8. Tenants cannot set a channel preference, see a consent, or stop autopay · (a)(c) · M → R-164

`apps/web/lib/notifications/actions.ts:58,65` hardcodes
`recipientType: 'STAFF'`, and there is no `/portal/account` route
(`portal/(signed-in)/` is `maintenance`, `messages`, `notices`, `papers`,
`pay`). So: no tenant has ever had a notification preference set by anyone;
no tenant can see or withdraw the TCPA consent recorded about them (R-051b);
no tenant can turn autopay off (the copy tells them to phone the office);
email opt-out works only by replying to an email (R-097e), and a guarantor
emailing in lands in triage. Notification fatigue is what kills portal
adoption, and NOTIF-02's "locked categories with an explanation" only means
something if the unlocked ones are actually adjustable. Fix: a
`/portal/account` screen — categories with the locked ones explained, consent
shown with its recorded basis and a withdraw control writing a new
`TenantConsent` row, autopay off routed through `switchDecision` (D-29/D-36
already refuse the email-less case), digest opt-in. Plus a staff-side mirror
so the non-digital tenant's preference can be set for them at the counter.

### 9. Nothing reminds anyone of a court date · (c) · S → R-159

`EvictionCase.courtDate` is stored and displayed; no job schedules against
it. A missed hearing loses the case by default and restarts the whole
sequence — a handful of times a year, at the highest cost per occurrence in
the product. Fix: `SCHEDULED_JOBS` entry raising a `Task` at T-7 and T-1 in
the property's local calendar, plus `affidavitReadiness`'s stale-DMDC-search
warning (R-085 left it render-only) as a second Task when a hearing is within
a week and the search is over 30 days old. Both are already-known facts and
one job.

### 10. Move-out proration was never built · (c) · S → R-160

`moveInProration` exists and is named for what it does; the mirror was
deferred to R-071 twice and never landed. A tenancy ending the 12th is
billed a full month, and the operator either eats the correction or a tenant
argues it against the deposit disposition in the same letter. Fix:
`moveOutProration` in core using the lease's own `prorationMethod`, pushed as
a credit invoice item at the moment `moveOutAt` is recorded, so the deposit
letter's "minus balance owed" line is the settled number rather than a number
with a known error in it.

### 11. Only one state is actually configurable, and there is no way to add the second · (a) · M → R-162

Beyond finding 1's data loss: the rule form never renders
`noticeServiceMethods`, the abandonment periods, `leaseViolationCureDays`,
the NSF pair or the surcharge pair, so a new state can only be configured by
writing a seed script. R-051 and R-083 both named the missing
service-method and eviction matrices. The seeded portfolio itself has FL
properties with no rule at all — `rulesFor()` throws. Fix: a "start a state
from an existing one" flow that clones a reviewed rule into a new state at
version 1 with every field editable, `citation`/`reviewedBy` **required**
before it can be made effective, and a portfolio screen naming which of your
states has no rule and which has one with unreviewed fields. R-055's "which
properties have no retaliation window" belongs on the same screen.

### 12. There is no vacancy loss and no economic occupancy anywhere · (c) · S → R-167

`occupancyRate` (R-075) has **zero callers** — three consecutive items said
they did not need it — and it counts a `DOWN` unit as vacant, which is a
physical reading. Nothing anywhere expresses vacancy in dollars:
`/vacancies` lists units and turnover stage, `/reports/property` counts
vacancy *days*. Fix: a vacancy-loss line — market rent × vacant days, per
unit, per property, per entity, over the report period — on
`/reports/property` and the rent roll footer; economic occupancy as
collected ÷ (scheduled + vacancy loss + concessions), with `DOWN` units
excluded from the denominator and said so on the page. Retire or rewrite
`occupancyRate` rather than leaving a second definition around.

### 13. A `Notice` body is still mutable · (a)(c) · S → R-161

`Message`, `LedgerEntry`, `AuditLog`, `NoticeDelivery` are append-only by
trigger. `Notice` is not — flagged in R-051 and carried unchanged through
R-052. Nothing edits it today, which is exactly how long that stays true.
The cost lands the one time it matters, in front of a judge, opposite a
tenant's photograph of the notice actually posted. Fix: the ledger's own
story — trigger on the table, correction is a superseding `Notice` linked to
the one it replaces, and the served original is never overwritten.

### 14. The reconciliation cannot see the money bug it has already had · (c) · M → R-163

D-25 is explicit that the nightly sweep compares the projection against *our
own* processed-event log and deliberately does not compare amounts. R-038a
then found the shape it is blind to: an event Stripe never sent leaves
nothing on either side. That defect ran live from R-038, and the payments it
left with no ledger entry are reported rather than backfilled. Fix: fetch
each open Stripe invoice's `amount_due`/`amount_paid` on the sweep and
compare against the projected lease balance; alarm the difference, never
correct it. `/money` already has the drift surface R-147 built. This is the
one place worth the extra API calls.

### 15. A guarantor is a role nobody can be · (a)(c) · M → R-165

`ROLE_DEFINITIONS` seeds `guarantor` with permissions; there is no
authentication path (R-004's leftover, never picked up), no portal, and
`Guarantor` rows are add-only — `addGuarantor` with no release, even though
R-090's amendment has every other party sign. Every co-signed tenancy hits
this — common with the thin-file applicants a 10–50 door operator actually
rents to. The guarantor is financially liable on the ledger and has never
been shown a balance, a notice, or a demand. Fix: magic-link entry to a
financial-only view (balance, ledger, notices — no maintenance, no comms, per
ROLE-01), the demand ladder addressed to them alongside the tenant, and a
release path through `LeasePartyChange` so the amendment that removes them is
signed rather than assumed.

### 16. The non-digital tenant still cannot be handed a receipt, and cheques cannot be batched · (c) · S → R-166

R-038 named both: no printable counter receipt at the moment of handover
(the tenant gets the ordinary emailed receipt once the webhook posts —
useless to Gene), and no deposit batching, though `Payment` already carries
channel, date and `receivedByStaffId`. Fix: print-ready receipt from
`packages/core`'s existing document generation on the record-payment
confirmation; a batch screen grouping undeposited offline payments by date
and receiver into a printable slip, with the batch id on each `Payment` so a
bank line reconciles to named tenancies.

## Do not build

- **A second work queue for cases.** Findings 7 and 9 both want reminders;
  both belong in `Task` (D-9). The storage build already paid for this
  lesson once.
- **Two-way calendar sync.** R-097c's own note is right — the conflict
  policy it needs can move an entry appointment somebody was legally noticed
  for. The .ics subscription is the whole value.
- **A settings UI for `NO_RESPONSE_HOURS`, `APPROVAL_DEFAULTS`, the 4-hour
  SLA or the 2-day unanswered threshold.** Four items have flagged these as
  "config per the PRD". They are house rules, not statutes; D-4 governs
  numbers a legislature can change, and a settings screen for each is four
  screens nobody will open.
- **Dark mode, quarterly columns on the operating report, and a `VTIMEZONE`
  block.** Named in three entries as follow-on; none of them costs an
  operator anything.
- **Backfilling the historical payments R-038a left with no ledger entry.**
  The owner already called this correctly — reporting them is right, a
  corrective write across historical money has a bigger blast radius than
  the bug.
