import 'server-only'

import { formatCents } from '@rental/core/money'
import { lateFeeDeltaCents, lateFeeFor } from '@rental/core/ledger'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'

// Assessing late fees (PAY-04; D-4, D-12, R-040).
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
// safe, and it needs to know what this particular overdue charge has already
// attracted, which is what `Charge.assessedOnChargeId` is for.

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

/**
 * One property's overdue rent, assessed for the day.
 *
 * Idempotent per (charge, business date) through the invoice item's own
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

  const result: AssessmentResult = {
    assessedCents: 0,
    chargesAssessed: 0,
    leasesChecked: overdue.length,
    failed: 0,
  }

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

    // The description defends the charge. "We computed $95 and charged $50
    // because Texas caps it" is a sentence that survives a dispute; a bare
    // "Late fee" is not.
    const description =
      decision.cappedAtCents != null
        ? `Late fee — ${decision.daysLate} days past due (${decision.ruleSummary}; capped at ${formatCents(decision.cappedAtCents)})`
        : `Late fee — ${decision.daysLate} days past due (${decision.ruleSummary})`

    try {
      const item = await getBillingProvider().addInvoiceItem({
        stripeCustomerId: payer.stripeCustomerId,
        amountCents: deltaCents,
        currency: 'usd',
        description,
        // Keyed on the fact: this rent charge, this business date. A retried
        // run adds the fee once.
        idempotencyKey: `latefee:${charge.id}:${today}`,
      })

      await prisma.$transaction(async (tx) => {
        const fee = await tx.charge.create({
          data: {
            propertyId,
            leaseId: charge.leaseId,
            type: 'LATE_FEE',
            amountCents: deltaCents,
            description,
            dueOn: new Date(`${today}T00:00:00.000Z`),
            assessedOnChargeId: charge.id,
            // WHICH VERSION of the rule produced this number. A rule is
            // versioned and effective-dated (D-4), and "what did the law say
            // on the day we charged it" is the first question in any
            // dispute - it cannot be reconstructed from today's row.
            jurisdictionRuleId: rule.id,
            stripeInvoiceItemId: item.stripeInvoiceItemId,
          },
        })
        await auditAsSystem(
          'ledger.late_fee',
          {
            action: 'ledger.adjusted',
            entityType: 'Charge',
            entityId: fee.id,
            propertyId,
            // No `reasonCode`: that enum is waiver-flavoured (goodwill,
            // hardship, first_occurrence...) and none of its values describes
            // a rule firing on a schedule. Better an honest free-text reason
            // than a code that means something else.
            //
            // REQUIRED on ledger.adjusted, and rightly - "why" is the point
            // of the record. Written as the sentence that defends the charge
            // rather than a code, because this is what somebody reads in a
            // dispute six months later.
            reason: description,
            after: {
              onChargeId: charge.id,
              amountCents: deltaCents,
              computedCents: decision.computedCents,
              cappedAtCents: decision.cappedAtCents,
              daysLate: decision.daysLate,
              jurisdictionRuleId: rule.id,
              stripeInvoiceItemId: item.stripeInvoiceItemId,
            },
          },
          tx,
        )
      })

      result.assessedCents += deltaCents
      result.chargesAssessed += 1
    } catch (error) {
      console.error(`[late-fee] could not assess on charge ${charge.id}`, error)
      result.failed += 1
    }
  }

  return result
}
