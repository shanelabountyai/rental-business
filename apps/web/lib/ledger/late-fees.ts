import 'server-only'

import { formatCents } from '@rental/core/money'
import {
  allocateBalance,
  balanceCents,
  lateFeeDeltaCents,
  lateFeeOutsideHolds,
  rentPeriodDebts,
} from '@rental/core/ledger'
import type { LateFeeDecision } from '@rental/core/ledger'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import { liftSettledNoticeHolds } from '@/lib/holds/notice-hold-lift.ts'
import { haltedLeasesInProperty, heldSpansInProperty } from '@/lib/holds/queries.ts'
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
// Pass 1 (dated charges) is UNCHANGED. Pass 2 assesses the periods the
// subscription billed with NO charge row behind them, one fee per period.
// THE TWO PASSES ARE SEPARATED BY DEBT, NOT BY LEASE - R-205 found that
// separating them by lease silently excluded every mid-month move-in from
// both, because a move-in proration is itself a `RENT` charge. The long note
// above pass 2 is the whole story.
//
// Both anchor a fee differently: a dated charge to itself
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
  /// R-084: tenancies the sweep passed over because a hold halts late fees -
  /// a bankruptcy stay, an SCRA protection, a payment plan. Reported rather
  /// than silently absent, because "the fee did not accrue" and "the job did
  /// not see the lease" look identical on a ledger and are very different
  /// problems.
  heldLeases: number
  /// R-227: fees on today's open debts that fell on days a hold covered and
  /// so will never be charged - the report the backlog asked for in place of
  /// a backfill. A snapshot as of this run, NOT a sum: tomorrow's run reports
  /// the same held days again for any debt still open.
  heldBackCents: number
  /// R-227: served notices' fee stops lifted this run.
  noticeHoldsLifted: number
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

  // R-227: before the rule, so a notice in a state with no fee rule is still
  // lifted on its verdict - and before `heldFromFees` below, so the night a
  // notice is settled is the first night its tenancy is assessed again.
  const noticeHoldsLifted = await liftSettledNoticeHolds(propertyId, now)

  const rule = await rulesFor({ state: property.state, county: property.county }, now).catch(
    () => null,
  )
  // No configured rule means no fee. NOT a default fee, and not an error:
  // D-4's whole point is that a statutory number comes from configuration,
  // and inventing one for an unconfigured state is how a product charges an
  // unlawful fee in a market nobody has set up yet.
  if (!rule) {
    return { assessedCents: 0, chargesAssessed: 0, leasesChecked: 0, failed: 0, heldLeases: 0, heldBackCents: 0, noticeHoldsLifted }
  }

  const result: AssessmentResult = {
    assessedCents: 0,
    chargesAssessed: 0,
    leasesChecked: 0,
    failed: 0,
    heldLeases: 0,
    heldBackCents: 0,
    noticeHoldsLifted,
  }

  // R-084. ONE QUERY FOR THE WHOLE PROPERTY, read before either pass, and
  // consulted by both - a per-lease check inside the loops would be a query
  // per tenancy on the nightly job for ever. Asks for the EFFECT, never for
  // a hold type: a seventh type that halts late fees is covered here on the
  // day it is added to packages/core/holds.
  const heldFromFees = await haltedLeasesInProperty(propertyId, 'halt_late_fees')
  // R-227: and every span one WAS in force, so a lifted hold's days stay
  // uncharged - the fee is cumulative, and without this the first night after
  // a lift charged every day the hold had covered.
  const heldSpans = await heldSpansInProperty(propertyId, 'halt_late_fees', property.timezone)

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
    if (heldFromFees.has(charge.leaseId)) {
      result.heldLeases += 1
      continue
    }

    // Outstanding on the RENT itself. A partially-paid charge accrues a
    // percentage fee on the remainder, never on money already received -
    // see `LateFeeFacts.outstandingCents`.
    const applied = charge.ledgerEntries
      .filter((entry) => entry.type !== 'CHARGE')
      .reduce((total, entry) => total + entry.amountCents, 0)
    const outstandingCents = charge.amountCents + applied
    if (outstandingCents <= 0) continue

    const { decision, heldBackCents } = lateFeeOutsideHolds(
      rule,
      {
        outstandingCents,
        monthlyRentCents: charge.lease.rentCents,
        // `@db.Date` comes back as UTC midnight; reading it with local getters
        // is off by one for any server west of UTC, which is exactly how
        // `daysPastDue` once reported a day late ON the due date.
        dueOn: utcToBusinessDate(charge.dueOn),
        asOf: today,
      },
      heldSpans.get(charge.leaseId) ?? [],
    )
    result.heldBackCents += heldBackCents

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

  // ---- Pass 2: the subscription's own rent, PERIOD BY PERIOD (R-205) ----
  //
  // ==========================================================================
  // WHAT R-205 FOUND, AND WHY THIS PASS NO LONGER FILTERS BY LEASE.
  //
  // This pass used to select leases holding NO `RENT` Charge at all, on the
  // reasoning that a lease with one belonged to pass 1. But
  // `chargeMoveInProration` writes exactly such a charge at activation - it
  // IS rent, for fewer days than usual - so EVERY lease that did not start on
  // its rent due day was excluded from this pass for the life of the tenancy,
  // while pass 1 reached only the proration, found it paid, and moved on. The
  // ordinary monthly rent underneath was assessed by neither pass: a tenant
  // fifteen days late every month for three years was charged nothing, and
  // the job recorded SUCCEEDED with `chargesAssessed: 0`.
  //
  // The two passes are separated by DEBT, not by lease. Pass 1 assesses the
  // dated `Charge` rows; this pass assesses the periods the subscription
  // billed with no charge row behind them (D-11/D-40). A lease can hold both
  // and they never compete for the same debt.
  //
  // AND THE BASE IS THE PERIOD, NOT THE ARREARS. This pass used to hand
  // `lateFeeFor` the whole ledger balance as `outstandingCents`, so a
  // PERCENT_OF_RENT rule took 5% of $3,000 of accumulated arrears - $150 -
  // for being late on one $1,500 month, and at three months took a percentage
  // of a figure that already included the fees it had itself assessed.
  // `allocateBalance` - the same allocation the rent roll and a cure notice's
  // demand read (R-118, R-194) - says how much of the balance each period is
  // still sitting on, and THAT is what each period's fee is computed from.
  //
  // NEEDS COUNSEL, and the row says so: whether a percentage fee may lawfully
  // take arrears rather than the period's own rent as its base is a legal
  // question. What is not in question is that the two passes must not
  // disagree about it, and before this they did.
  //
  // THE FEES NEVER ASSESSED ARE NOT BACKFILLED (D-201). This fixes the writer
  // from today forward; a tenancy that was never charged stays never charged,
  // because a reconciled ledger is not a place to post three years of
  // retrospective fees nobody was ever told about.
  // ==========================================================================

  const leases = await prisma.lease.findMany({
    where: { propertyId, status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
    select: {
      id: true,
      rentCents: true,
      leasePayers: {
        where: { active: true },
        select: { id: true, stripeCustomerId: true },
        take: 1,
      },
      ledgerEntries: {
        select: {
          id: true,
          type: true,
          chargeId: true,
          amountCents: true,
          occurredAt: true,
          description: true,
        },
      },
      // Every unwaived charge, as a DEBT competing for the balance - not as
      // something this pass assesses. A waived fee is not a debt (PAY-04),
      // and a fee that is real absorbs its own share of what the tenant has
      // paid before the rent underneath it does. The same list
      // `delinquencyFor` allocates over, so this pass and the rent-roll
      // screen can never disagree about which period is still owed.
      charges: { where: { waivedAt: null }, select: { dueOn: true, amountCents: true } },
      // Every LATE_FEE already posted against this lease's unlinked rent,
      // matched below to the period it answered to.
      assessedLateFees: { select: { amountCents: true, assessedForDueOn: true } },
    },
  })
  result.leasesChecked += leases.length

  for (const lease of leases) {
    if (heldFromFees.has(lease.id)) {
      result.heldLeases += 1
      continue
    }

    const balance = balanceCents(lease.ledgerEntries)
    if (balance <= 0) continue

    const periods = rentPeriodDebts(lease.ledgerEntries, property.timezone)
    if (periods.length === 0) continue

    // Tagged rather than kept in two lists: the allocation has to see every
    // debt competing for the balance, and only the rent periods are assessed
    // here.
    const { owed } = allocateBalance(
      [
        ...lease.charges.map((charge) => ({
          // `@db.Date` comes back as UTC midnight; a timezone must not touch
          // a calendar day.
          dueOn: utcToBusinessDate(charge.dueOn),
          amountCents: charge.amountCents,
          rentPeriod: false,
        })),
        ...periods.map((period) => ({ ...period, rentPeriod: true })),
      ],
      balance,
    )

    for (const { debt, owedCents } of owed) {
      if (!debt.rentPeriod) continue

      const { decision, heldBackCents } = lateFeeOutsideHolds(
        rule,
        {
          // THIS PERIOD's unpaid rent, never the whole arrears.
          outstandingCents: owedCents,
          monthlyRentCents: lease.rentCents,
          dueOn: debt.dueOn,
          asOf: today,
        },
        heldSpans.get(lease.id) ?? [],
      )
      result.heldBackCents += heldBackCents

      // Scoped to THIS due cycle, not every fee this lease has ever
      // attracted - see the migration's own note on why `assessedForDueOn`
      // exists at all.
      const alreadyAssessedCents = lease.assessedLateFees
        .filter((fee) => fee.assessedForDueOn && utcToBusinessDate(fee.assessedForDueOn) === debt.dueOn)
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
          // Keyed on the fact: this lease, this rent period, this business
          // date. A retried run adds the fee once; a distinct period gets
          // its own key.
          idempotencyKey: `latefee:lease:${lease.id}:${debt.dueOn}:${today}`,
          anchor: { assessedOnLeaseId: lease.id, assessedForDueOn: debt.dueOn },
          onChargeDescription: `lease ${lease.id} (unlinked rent due ${debt.dueOn})`,
        })
        result.assessedCents += deltaCents
        result.chargesAssessed += 1
      } catch (error) {
        console.error(`[late-fee] could not assess unlinked rent on lease ${lease.id}`, error)
        result.failed += 1
      }
    }
  }

  return result
}
