import 'server-only'

import { balanceCents, statement, reversedEntryIds } from '@rental/core/ledger'
import { cardFeeFor, payable, railsFor } from '@rental/core/payments'
import type { CollectionMethod, PaymentRail } from '@rental/core/payments'
import { prisma } from '@rental/db'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import type { TenantScope } from '@rental/core/portal'

// What the tenant sees before they pay (PAY-01, R-037).
//
// PAY-01: "when I open the portal, then I see current balance, due date, and
// itemized charges BEFORE paying." Before is the operative word - a tenant
// deciding whether they can cover rent this week needs the number and its
// parts on the way in, not a receipt on the way out.
//
// SCOPED TO THEIR OWN LEASE, in the query and not in the template. R-018 set
// that rule for documents and it is the same rule here, with more at stake:
// a template that hides a row has already sent somebody else's balance to
// the browser.

/**
 * Retail cash (PAY-01's cash-preferring tenant) is not wired to anything.
 *
 * There is no Stripe rail for it - it is a third-party network (PayNearMe,
 * Green Dot and similar) and no vendor has been chosen. Rather than ship a
 * simulated driver that mints fake settlements, the rail is a first-class
 * concept everywhere (`PaymentRail`, `PaymentChannel`) and is offered as
 * unavailable with a reason. D-15's rule, unchanged: an adapter that has
 * never once been executed against a real account produces code that looks
 * finished and is untested. R-038 owns recording cash a tenant hands over in
 * person; the retail network itself needs a vendor decision first.
 */
const RETAIL_CASH_CONFIGURED = false

export interface PayableCharge {
  id: string
  type: string
  description: string
  dueOn: Date | null
  outstandingCents: number
}

export interface PaymentView {
  leaseId: string
  leasePayerId: string
  propertyName: string
  unitName: string
  balanceCents: number
  inFlightCents: number
  maxCents: number
  allowsPartial: boolean
  collectionMethod: CollectionMethod
  /// True when a payment method is on file AND the payer bills automatically.
  /// Both halves matter: a saved card on a `send_invoice` payer is not
  /// autopay, and an automatic payer with no method is an invoice that will
  /// fail (R-039a).
  autopayOn: boolean
  /// The day autopay pulls, and the latest day it safely could. Null debitDay
  /// means the rent due day (R-039a).
  debitDay: number | null
  rentDueDay: number
  latestSafeDebitDay: number
  charges: PayableCharge[]
  rails: { rail: PaymentRail; available: boolean; unavailableReason?: string }[]
  /// What a card would add to the FULL payable amount. Recomputed for the
  /// actual amount at the moment of payment - this is the disclosure figure
  /// for the screen, and the action never trusts it.
  cardFeeCents: number
  cardFeePermitted: boolean
  hasPaymentMethod: boolean
}

/**
 * Everything the pay screen needs, for the tenant's own lease.
 *
 * Returns null rather than throwing when the tenant has no lease with a
 * payer set up - a tenant mid-onboarding is a real state, not an error, and
 * the screen says so in words.
 */
export async function paymentView(scope: TenantScope): Promise<PaymentView | null> {
  if (scope.leaseIds.length === 0) return null

  const payer = await prisma.leasePayer.findFirst({
    where: {
      leaseId: { in: [...scope.leaseIds] },
      tenantId: scope.tenantId,
      active: true,
    },
    select: {
      id: true,
      leaseId: true,
      collectionMethod: true,
      stripeCustomerId: true,
      defaultPaymentMethodId: true,
      debitDay: true,
      lease: {
        select: {
          id: true,
          rentDueDay: true,
          requireFullBalance: true,
          property: { select: { name: true, state: true, county: true } },
          unit: { select: { name: true } },
        },
      },
    },
  })
  if (!payer) return null

  const [entries, charges, inFlight, rule] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { leaseId: payer.leaseId },
      select: { id: true, amountCents: true },
    }),
    prisma.charge.findMany({
      where: { leaseId: payer.leaseId },
      select: {
        id: true,
        type: true,
        description: true,
        dueOn: true,
        amountCents: true,
        ledgerEntries: { select: { amountCents: true, type: true } },
      },
      orderBy: { dueOn: 'asc' },
    }),
    // Money Stripe has accepted but not settled, for THIS payer. Summed
    // rather than counted, because what the screen needs is how much of the
    // balance is already covered.
    prisma.payment.aggregate({
      where: { leasePayerId: payer.id, status: 'PENDING' },
      _sum: { amountCents: true },
    }),
    rulesFor(
      { state: payer.lease.property.state, county: payer.lease.property.county },
      new Date(),
    ).catch(() => null),
  ])

  const balance = balanceCents(
    entries.map((row) => ({ ...row, type: '', occurredAt: new Date(0), description: '' })),
  )
  const inFlightCents = inFlight._sum.amountCents ?? 0
  const method = payer.collectionMethod as CollectionMethod
  // The owner's switch travels with the facts (R-039a). Without this the
  // flag would be a column nothing reads - and `validatePaymentAmount` is
  // where it has to bite, so a hand-crafted request cannot get around it.
  const limits = payable({
    method,
    balanceCents: balance,
    inFlightCents,
    requireFullBalance: payer.lease.requireFullBalance,
  })

  // D-4: whether the tenant may be charged the card cost is a jurisdiction
  // fact. A property with no rule configured is treated as NOT permitted -
  // charging a fee we cannot point at a rule for is the wrong way to be
  // wrong.
  const cardRule = {
    cardSurchargePermitted: rule?.cardSurchargePermitted ?? false,
    cardSurchargeMaxBps: rule?.cardSurchargeMaxBps ?? null,
  }
  const fee = cardFeeFor(cardRule, limits.maxCents)

  return {
    leaseId: payer.leaseId,
    leasePayerId: payer.id,
    propertyName: payer.lease.property.name,
    unitName: payer.lease.unit?.name ?? '',
    balanceCents: balance,
    inFlightCents,
    maxCents: limits.maxCents,
    allowsPartial: limits.allowsPartial,
    collectionMethod: method,
    // BOTH halves, deliberately. A saved card on a `send_invoice` payer is
    // not autopay, and an automatic payer with no method on file is an
    // invoice that finalizes and then fails - which is exactly the state
    // every payer provisioned before R-039a was in.
    autopayOn: method === 'charge_automatically' && payer.defaultPaymentMethodId != null,
    debitDay: payer.debitDay,
    rentDueDay: payer.lease.rentDueDay,
    // The ceiling the tenant may choose up to, from the versioned rule (D-4).
    // No configured rule means no grace to spend, so the only safe day is the
    // due day itself - the same refusal-to-guess late fees and deposits make.
    latestSafeDebitDay: Math.min(28, payer.lease.rentDueDay + (rule?.graceDays ?? 0)),
    charges: charges
      .map((charge) => {
        // Outstanding is derived from the charge's own applications rather
        // than stored, the same rule `outstandingCharges` follows - a stored
        // remainder is a number that drifts.
        const applied = charge.ledgerEntries
          .filter((entry) => entry.type !== 'CHARGE')
          .reduce((total, entry) => total + entry.amountCents, 0)
        return {
          id: charge.id,
          type: charge.type,
          description: charge.description,
          dueOn: charge.dueOn,
          outstandingCents: charge.amountCents + applied,
        }
      })
      .filter((charge) => charge.outstandingCents > 0),
    rails: railsFor({
      method,
      cardPermitted: cardRule.cardSurchargePermitted,
      retailCashConfigured: RETAIL_CASH_CONFIGURED,
    }),
    cardFeeCents: fee.feeCents,
    cardFeePermitted: fee.permitted,
    hasPaymentMethod: payer.stripeCustomerId != null,
  }
}

/**
 * The tenant's own statement: every charge and payment, oldest first, with a
 * running balance (PAY-03, R-043).
 *
 * ==========================================================================
 * WHY THIS EXISTS. The pay screen shows what a tenant OWES. It has never
 * shown what they have PAID — so the one question that generates the calls,
 * "did you get my payment?", was unanswerable from the portal. The backlog's
 * claim is that half of those calls disappear when a tenant can see their own
 * ledger, and this is the screen that tests it.
 *
 * THE SAME ARITHMETIC AS THE STAFF VIEW, deliberately. `statement()` and
 * `balanceCents()` are the same functions `leaseStatement()` calls, over the
 * same rows. A tenant and a property manager looking at the same tenancy must
 * never see two different balances: that is the argument in every disputed
 * payment, and losing it costs more than the feature saves. What differs
 * between the two screens is the WORDING (D-10), never the numbers.
 *
 * AUTHORIZED BY THE PAYER ROW, not by a scope list. `leaseStatement()` takes
 * a staff `ResolvedScope`; this resolves the tenant's own active payer, which
 * is the same check `paymentView()` makes and the only one that means
 * anything on the portal side (R-018: the tenant side never falls through to
 * the staff side).
 * ==========================================================================
 */
export async function tenantStatement(scope: TenantScope) {
  if (scope.leaseIds.length === 0) return null

  const payer = await prisma.leasePayer.findFirst({
    where: { leaseId: { in: [...scope.leaseIds] }, tenantId: scope.tenantId, active: true },
    select: {
      leaseId: true,
      lease: {
        select: {
          property: { select: { name: true, timezone: true } },
          unit: { select: { name: true } },
        },
      },
    },
  })
  if (!payer) return null

  const rows = await prisma.ledgerEntry.findMany({
    where: { leaseId: payer.leaseId },
    orderBy: { occurredAt: 'asc' },
    select: {
      id: true,
      type: true,
      amountCents: true,
      occurredAt: true,
      description: true,
      reversesId: true,
    },
  })

  return {
    propertyName: payer.lease.property.name,
    unitName: payer.lease.unit.name,
    timezone: payer.lease.property.timezone,
    lines: statement(rows),
    // Both sides, because D-11 makes a correction a new REVERSAL row rather
    // than an edit - the original stays visible and the tenant sees what
    // actually happened instead of a tidied history.
    reversed: reversedEntryIds(rows),
    balanceCents: balanceCents(rows),
  }
}
