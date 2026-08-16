import 'server-only'

import { formatCents } from '@rental/core/money'
import { balanceCents, delinquencyFor, lateFeeDeltaCents, lateFeeFor } from '@rental/core/ledger'
import type { LateFeeDecision } from '@rental/core/ledger'
import { businessDate, dueDateOnOrBefore, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'

// Assessing late fees (PAY-04; D-4, D-12, R-040, R-050b).
//
// D-12 in its purest form: the number is decided in `packages/core` from
// versioned jurisdiction configuration, clamped to the statutory ceiling, and
// pushed to Stripe as an invoice item. Stripe never computes a late fee,
// because Stripe does not know what state the property is in.
//
// THE DELTA, NOT THE TOTAL. `lateFeeFor()` returns the cumulative fee owed as
// of a date, which is correct for a daily-accruing rule and is a trap for
// anything on a schedule - charging it nightly compounds a $10/day fee into
// $60 by day three. `lateFeeDeltaCents()` is what makes a nightly assessment
// safe, and it needs to know what has already been attracted against THIS
// debt, which needs an anchor - see below.
//
// ==========================================================================
// TWO PASSES, BECAUSE THERE ARE TWO KINDS OF "OVERDUE RENT" (R-050b).
//
// D-11/D-40 mint a `Charge` row for rent only in the exceptions - a move-in
// proration, a hand-recorded charge. Ordinary subscription-billed rent
// (month two onward, the common case for every lease past its first month)
// posts as an UNLINKED ledger entry with no `Charge` behind it at all.
// `rentRoll()`'s aging already had to solve this on the READ side (R-044,
// R-045): fall back to a `rentDueDay`-derived date when no dated charge
// exists. This function did not, and walking Demo checkpoint 2 (D-28) is
// what found it: `assessLateFees` only ever queried `Charge` rows, so it
// silently never fired on the common case at all.
//
// Pass 1 (dated charges) is UNCHANGED from before this item - it is
// well-exercised and the risk of touching it is not worth taking. Pass 2
// (unlinked rent) is new, and only runs for leases that never got a dated
// RENT charge in the first place, so the two passes never compete for the
// same debt. Both anchor a fee differently: a dated charge to itself
// (`assessedOnChargeId`, unchanged); unlinked rent to the LEASE plus WHICH
// due cycle it answers to (`assessedOnLeaseId` + `assessedForDueOn`) -
// `Charge.dueOn` on the fee itself is already the day it was assessed, not
// the rent due date, so it cannot double as that anchor. See the migration
// that added those two columns for why a lease alone is not enough.
// ==========================================================================

export interface AssessmentResult {
  assessedCents: number
  chargesAssessed: number
  leasesChecked: number
  failed: number
}

/// Charge types a late fee is assessed ON. Rent, and deliberately nothing
/// else: a late fee on a late fee is compounding by another name, and a fee
/// on a utility rebill is not what PAY-04's grace period was written about.
const LATE_FEE_APPLIES_TO = ['RENT'] as const

/// Shared by both passes: turn a computed delta into a posted Charge, an
/// invoice item, and an audit entry. The two passes differ only in how they
/// anchor the fee and what its idempotency key and description carry.
async function postLateFeeDelta(params: {
  propertyId: string
  leaseId: string
  deltaCents: number
  decision: LateFeeDecision
  ruleId: string
  today: string
  stripeCustomerId: string
  idempotencyKey: string
  anchor: { assessedOnChargeId: string } | { assessedOnLeaseId: string; assessedForDueOn: string }
  onChargeDescription: string
}): Promise<void> {
  const description =
    params.decision.cappedAtCents != null
      ? `Late fee — ${params.decision.daysLate} days past due (${params.decision.ruleSummary}; capped at ${formatCents(params.decision.cappedAtCents)})`
      : `Late fee — ${params.decision.daysLate} days past due (${params.decision.ruleSummary})`

  // THE CHARGE ROW FIRST, so its id can ride into Stripe's metadata and come
  // back on the invoice line - which is what links the projected ledger
  // entry to this fee. Created before the push and left with a null
  // `stripeInvoiceItemId` if the push fails, which is recoverable and
  // visible; pushing first would mean an invoice item in Stripe that names a
  // charge id that does not exist.
  const fee = await prisma.charge.create({
    data: {
      propertyId: params.propertyId,
      leaseId: params.leaseId,
      type: 'LATE_FEE',
      amountCents: params.deltaCents,
      description,
      dueOn: new Date(`${params.today}T00:00:00.000Z`),
      jurisdictionRuleId: params.ruleId,
      ...('assessedOnChargeId' in params.anchor
        ? { assessedOnChargeId: params.anchor.assessedOnChargeId }
        : {
            assessedOnLeaseId: params.anchor.assessedOnLeaseId,
            assessedForDueOn: new Date(`${params.anchor.assessedForDueOn}T00:00:00.000Z`),
          }),
    },
  })

  const item = await getBillingProvider().addInvoiceItem({
    stripeCustomerId: params.stripeCustomerId,
    amountCents: params.deltaCents,
    currency: 'usd',
    description,
    chargeId: fee.id,
    idempotencyKey: params.idempotencyKey,
  })

  await prisma.$transaction(async (tx) => {
    await tx.charge.update({
      where: { id: fee.id },
      data: { stripeInvoiceItemId: item.stripeInvoiceItemId },
    })
    await auditAsSystem(
      'ledger.late_fee',
      {
        action: 'ledger.adjusted',
        entityType: 'Charge',
        entityId: fee.id,
        propertyId: params.propertyId,
        // No `reasonCode`: that enum is waiver-flavoured (goodwill, hardship,
        // first_occurrence...) and none of its values describes a rule
        // firing on a schedule. Better an honest free-text reason than a
        // code that means something else.
        reason: description,
        after: {
          on: params.onChargeDescription,
          amountCents: params.deltaCents,
          computedCents: params.decision.computedCents,
          cappedAtCents: params.decision.cappedAtCents,
          daysLate: params.decision.daysLate,
          jurisdictionRuleId: params.ruleId,
          stripeInvoiceItemId: item.stripeInvoiceItemId,
        },
      },
      tx,
    )
  })
}

/**
 * One property's overdue rent, assessed for the day.
 *
 * Idempotent per (debt, business date) through the invoice item's own
 * idempotency key AND through the delta arithmetic: a second run on the same
 * day finds the fee already assessed and computes zero.
 */
export async function assessLateFees(
  propertyId: string,
  now = new Date(),
): Promise<AssessmentResult> {
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
    select: { id: true, state: true, county: true, timezone: true },
  })
  const today = businessDate(now, property.timezone)

  const rule = await rulesFor({ state: property.state, county: property.county }, now).catch(
    () => null,
  )
  // No configured rule means no fee. NOT a default fee, and not an error:
  // D-4's whole point is that a statutory number comes from configuration,
  // and inventing one for an unconfigured state is how a product charges an
  // unlawful fee in a market nobody has set up yet.
  if (!rule) {
    return { assessedCents: 0, chargesAssessed: 0, leasesChecked: 0, failed: 0 }
  }

  const result: AssessmentResult = {
    assessedCents: 0,
    chargesAssessed: 0,
    leasesChecked: 0,
    failed: 0,
  }

  // ---- Pass 1: dated RENT charges (unchanged) ----

  const overdue = await prisma.charge.findMany({
    where: {
      propertyId,
      type: { in: [...LATE_FEE_APPLIES_TO] },
      waivedAt: null,
      dueOn: { lt: new Date(`${today}T00:00:00.000Z`) },
      lease: { status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
    },
    select: {
      id: true,
      leaseId: true,
      amountCents: true,
      dueOn: true,
      lease: {
        select: {
          id: true,
          rentCents: true,
          leasePayers: {
            where: { active: true },
            select: { id: true, stripeCustomerId: true },
            take: 1,
          },
        },
      },
      // What has already been paid or credited against this rent.
      ledgerEntries: { select: { amountCents: true, type: true } },
      // What this rent has already attracted in fees.
      assessedFees: { select: { amountCents: true, waivedAt: true } },
    },
  })
  result.leasesChecked += overdue.length

  for (const charge of overdue) {
    // Outstanding on the RENT itself. A partially-paid charge accrues a
    // percentage fee on the remainder, never on money already received -
    // see `LateFeeFacts.outstandingCents`.
    const applied = charge.ledgerEntries
      .filter((entry) => entry.type !== 'CHARGE')
      .reduce((total, entry) => total + entry.amountCents, 0)
    const outstandingCents = charge.amountCents + applied
    if (outstandingCents <= 0) continue

    const decision = lateFeeFor(rule, {
      outstandingCents,
      monthlyRentCents: charge.lease.rentCents,
      // `@db.Date` comes back as UTC midnight; reading it with local getters
      // is off by one for any server west of UTC, which is exactly how
      // `daysPastDue` once reported a day late ON the due date.
      dueOn: utcToBusinessDate(charge.dueOn),
      asOf: today,
    })

    // A WAIVED fee still counts as assessed. Waiving is a decision to forgive
    // a fee that was correctly charged (PAY-04), not a statement that it was
    // never owed - so re-charging it the next night would quietly undo the
    // waiver, which is the opposite of what the person who granted it meant.
    const alreadyAssessedCents = charge.assessedFees.reduce(
      (total, fee) => total + fee.amountCents,
      0,
    )
    const deltaCents = lateFeeDeltaCents(decision, alreadyAssessedCents)
    if (deltaCents <= 0) continue

    const payer = charge.lease.leasePayers[0]
    if (!payer?.stripeCustomerId) {
      // Nothing to bill it to. Counted as a failure rather than skipped
      // silently: a lease accruing fees with no billing set up is a real
      // operational problem somebody should see on the job's own record.
      result.failed += 1
      continue
    }

    try {
      await postLateFeeDelta({
        propertyId,
        leaseId: charge.leaseId,
        deltaCents,
        decision,
        ruleId: rule.id,
        today,
        stripeCustomerId: payer.stripeCustomerId,
        // Keyed on the fact: this rent charge, this business date. A
        // retried run adds the fee once.
        idempotencyKey: `latefee:${charge.id}:${today}`,
        anchor: { assessedOnChargeId: charge.id },
        onChargeDescription: charge.id,
      })
      result.assessedCents += deltaCents
      result.chargesAssessed += 1
    } catch (error) {
      console.error(`[late-fee] could not assess on charge ${charge.id}`, error)
      result.failed += 1
    }
  }

  // ---- Pass 2: unlinked rent - leases that never got a dated RENT charge ----

  const unlinkedLeases = await prisma.lease.findMany({
    where: {
      propertyId,
      status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] },
      charges: { none: { type: { in: [...LATE_FEE_APPLIES_TO] } } },
    },
    select: {
      id: true,
      rentCents: true,
      rentDueDay: true,
      leasePayers: {
        where: { active: true },
        select: { id: true, stripeCustomerId: true, debitDay: true },
        take: 1,
      },
      ledgerEntries: {
        select: { id: true, type: true, amountCents: true, occurredAt: true, description: true },
      },
      // Every LATE_FEE already posted against this lease's unlinked balance,
      // grouped by which due cycle it answered to below.
      assessedLateFees: { select: { amountCents: true, assessedForDueOn: true } },
    },
  })
  result.leasesChecked += unlinkedLeases.length

  for (const lease of unlinkedLeases) {
    const balance = balanceCents(lease.ledgerEntries)
    const rentDueDay = lease.leasePayers[0]?.debitDay ?? lease.rentDueDay
    const nearestRentDueOn = dueDateOnOrBefore(today, rentDueDay)

    // Reusing `delinquencyFor` rather than re-deriving grace/bucket logic:
    // the same function `rentRoll()` displays from, so a lease this pass
    // fires on and the rent-roll screen showing it "past grace" can never
    // silently disagree.
    const delinquency = delinquencyFor({
      openCharges: [],
      balanceCents: balance,
      asOf: today,
      graceDays: rule.graceDays,
      nearestRentDueOn,
    })
    if (!delinquency.pastGrace || delinquency.balanceCents <= 0 || !delinquency.oldestDueOn) continue

    const decision = lateFeeFor(rule, {
      outstandingCents: delinquency.balanceCents,
      monthlyRentCents: lease.rentCents,
      dueOn: delinquency.oldestDueOn,
      asOf: today,
    })

    // Scoped to THIS due cycle, not every fee this lease has ever attracted -
    // see the migration's own note on why `assessedForDueOn` exists at all.
    const alreadyAssessedCents = lease.assessedLateFees
      .filter((fee) => utcToBusinessDate(fee.assessedForDueOn!) === delinquency.oldestDueOn)
      .reduce((total, fee) => total + fee.amountCents, 0)
    const deltaCents = lateFeeDeltaCents(decision, alreadyAssessedCents)
    if (deltaCents <= 0) continue

    const payer = lease.leasePayers[0]
    if (!payer?.stripeCustomerId) {
      result.failed += 1
      continue
    }

    try {
      await postLateFeeDelta({
        propertyId,
        leaseId: lease.id,
        deltaCents,
        decision,
        ruleId: rule.id,
        today,
        stripeCustomerId: payer.stripeCustomerId,
        // Keyed on the fact: this lease, this due cycle, this business
        // date. A retried run adds the fee once; a later, distinct cycle
        // gets its own key.
        idempotencyKey: `latefee:lease:${lease.id}:${delinquency.oldestDueOn}:${today}`,
        anchor: { assessedOnLeaseId: lease.id, assessedForDueOn: delinquency.oldestDueOn },
        onChargeDescription: `lease ${lease.id} (unlinked rent due ${delinquency.oldestDueOn})`,
      })
      result.assessedCents += deltaCents
      result.chargesAssessed += 1
    } catch (error) {
      console.error(`[late-fee] could not assess unlinked rent on lease ${lease.id}`, error)
      result.failed += 1
    }
  }

  return result
}
