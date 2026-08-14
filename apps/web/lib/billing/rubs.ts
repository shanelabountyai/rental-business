import 'server-only'

import { type RubsShare, allocateUtilityBill } from '@rental/core/billing'
import { formatCents } from '@rental/core/money'
import { utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { getBillingProvider } from './provider.ts'

// Charging a utility bill on to the tenants (PAY-08, R-042; D-4, D-12).
//
// Structurally the fourth fee-push in the product, and it follows the same
// shape as the other three (`assessLateFees`, `assessNsfFee`,
// `chargeMoveInProration`): core computes the amount, the `Charge` row is
// created FIRST so its id rides into Stripe's metadata and comes back on the
// invoice line, and a failed push leaves the Charge standing with a null
// `stripeInvoiceItemId` rather than an invoice item at Stripe naming a charge
// that does not exist.
//
// AN INVOICE ITEM, NOT A SUBSCRIPTION ITEM. A flat utility fee is a term of
// the contract and Stripe repeats it (see recurring.ts); a RUBS share is a
// different number every month because the bill is. D-12 is exactly this
// case.
//
// GATED ON THE JURISDICTION (D-4). Several states restrict or forbid RUBS,
// and `JurisdictionRule.rubsPermitted` has existed since R-010 with a form
// field, a seed value and no reader. This is its reader.

export type AllocationOutcome =
  | 'allocated'
  | 'already_allocated'
  | 'not_permitted'
  | 'no_rule'
  | 'refused'

export interface AllocationResult {
  outcome: AllocationOutcome
  /// Why, in the words a person on the screen needs. Never a bare code: the
  /// reason a bill cannot be split is usually something they can fix.
  detail?: string
  chargedCents?: number
  landlordCents?: number
  charges?: { leaseId: string; unitName: string; amountCents: number }[]
}

/**
 * Split a recorded bill across the units and charge the occupied ones.
 *
 * Idempotent on the bill: `allocatedAt` is the guard, and a bill allocated
 * twice bills every tenant twice.
 */
export async function allocateBill(
  utilityBillId: string,
  staffUserId: string | null = null,
): Promise<AllocationResult> {
  const bill = await prisma.utilityBill.findUniqueOrThrow({
    where: { id: utilityBillId },
    select: {
      id: true,
      propertyId: true,
      utilityType: true,
      amountCents: true,
      method: true,
      periodStart: true,
      periodEnd: true,
      allocatedAt: true,
      property: {
        select: {
          state: true,
          county: true,
          units: {
            orderBy: { name: 'asc' },
            select: {
              id: true,
              name: true,
              bedrooms: true,
              squareFeet: true,
              leases: {
                where: { status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
                orderBy: { startsOn: 'desc' },
                take: 1,
                select: {
                  id: true,
                  leasePayers: {
                    where: { active: true },
                    orderBy: { createdAt: 'asc' },
                    take: 1,
                    select: { stripeCustomerId: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  })

  if (bill.allocatedAt) {
    return { outcome: 'already_allocated', detail: 'This bill has already been split.' }
  }

  // D-4: the statutory question is asked of the versioned rule, never of a
  // literal. A state nobody has configured is a real gap and fails loudly
  // rather than defaulting to "yes, charge it on".
  const rule = await rulesFor(
    { state: bill.property.state, county: bill.property.county },
    new Date(),
  ).catch(() => null)
  if (!rule) {
    return {
      outcome: 'no_rule',
      detail: `No jurisdiction rule is configured for ${bill.property.state}, so whether RUBS is permitted there is unknown. Add one before splitting this bill.`,
    }
  }
  if (!rule.rubsPermitted) {
    return {
      outcome: 'not_permitted',
      detail: `${bill.property.state} does not permit utility bills to be split across units this way, so this bill cannot be charged on.`,
    }
  }

  // `@db.Date` - calendar days that Prisma returns as UTC midnight. Read with
  // `utcToBusinessDate`, never through a timezone: that conversion is the
  // R-042 off-by-one and it would move a billing period a day west of UTC.
  const periodStart = utcToBusinessDate(bill.periodStart)
  const periodEnd = utcToBusinessDate(bill.periodEnd)

  const allocation = allocateUtilityBill({
    amountCents: bill.amountCents,
    utilityLabel: utilityLabel(bill.utilityType),
    periodStart,
    periodEnd,
    method: bill.method,
    // EVERY unit at the property, occupied or not. Core charges only the
    // occupied ones and hands back the vacant units' share as the owner's -
    // spreading it across the tenants would make a tenant's bill go up
    // because the neighbour moved out.
    units: bill.property.units.map((unit) => ({
      unitId: unit.id,
      unitName: unit.name,
      leaseId: unit.leases[0]?.id ?? null,
      bedrooms: unit.bedrooms,
      squareFeet: unit.squareFeet,
    })),
  })

  if (!allocation.ok) return { outcome: 'refused', detail: allocation.error }

  const customerByLease = new Map<string, string | null>()
  for (const unit of bill.property.units) {
    const lease = unit.leases[0]
    if (lease) customerByLease.set(lease.id, lease.leasePayers[0]?.stripeCustomerId ?? null)
  }

  const written: { leaseId: string; unitName: string; amountCents: number }[] = []
  for (const share of allocation.shares) {
    // A zero share is a real outcome - a studio with no bedrooms on a
    // bedroom split - and writing a $0.00 line on somebody's invoice is
    // noise, exactly as it is for a proration.
    if (share.amountCents === 0) continue
    await chargeShare(bill, share, customerByLease.get(share.leaseId) ?? null)
    written.push({
      leaseId: share.leaseId,
      unitName: share.unitName,
      amountCents: share.amountCents,
    })
  }

  const chargedCents = written.reduce((total, row) => total + row.amountCents, 0)

  await prisma.utilityBill.update({
    where: { id: bill.id },
    data: {
      allocatedAt: new Date(),
      allocatedByStaffId: staffUserId,
      landlordCents: allocation.landlordCents,
    },
  })

  await auditAsSystem('billing.rubs', {
    action: 'billing.rubs_allocated',
    entityType: 'UtilityBill',
    entityId: bill.id,
    propertyId: bill.propertyId,
    after: {
      utilityType: bill.utilityType,
      periodStart,
      periodEnd,
      billCents: bill.amountCents,
      method: allocation.method,
      // THE WHOLE SPLIT, not just the total. The defence of a RUBS charge is
      // being able to show the arithmetic against the bill it came from, and
      // an audit row saying only "allocated $412" cannot do that.
      weights: allocation.weights,
      shares: allocation.shares.map((share) => ({
        unitName: share.unitName,
        leaseId: share.leaseId,
        weight: share.weight,
        amountCents: share.amountCents,
      })),
      chargedCents,
      landlordCents: allocation.landlordCents,
      allocatedByStaffId: staffUserId,
    },
  }).catch((error: unknown) => {
    console.error(`[rubs] failed to audit bill ${bill.id}`, error)
  })

  return {
    outcome: 'allocated',
    chargedCents,
    landlordCents: allocation.landlordCents,
    charges: written,
  }
}

async function chargeShare(
  bill: { id: string; propertyId: string; periodStart: Date; periodEnd: Date },
  share: RubsShare,
  stripeCustomerId: string | null,
): Promise<void> {
  const charge = await prisma.charge.create({
    data: {
      propertyId: bill.propertyId,
      leaseId: share.leaseId,
      type: 'RUBS_ALLOCATION',
      amountCents: share.amountCents,
      // The arithmetic, in words. PAY-08 requires the method visible on the
      // ledger, and for a share of somebody else's bill that is the first
      // question every tenant asks.
      description: share.description,
      // Due when the period ended, not when somebody got round to entering
      // the bill. A late entry must not make the charge look late.
      dueOn: bill.periodEnd,
      periodStart: bill.periodStart,
      periodEnd: bill.periodEnd,
      utilityBillId: bill.id,
    },
  })

  if (!stripeCustomerId) return

  try {
    const item = await getBillingProvider().addInvoiceItem({
      stripeCustomerId,
      amountCents: share.amountCents,
      currency: 'usd',
      description: share.description,
      chargeId: charge.id,
      // Keyed on the FACT: this bill, this lease. A retried allocation adds
      // the share once rather than billing the tenant twice for one month of
      // water.
      idempotencyKey: `rubs:${bill.id}:${share.leaseId}`,
    })
    await prisma.charge.update({
      where: { id: charge.id },
      data: { stripeInvoiceItemId: item.stripeInvoiceItemId },
    })
  } catch (error) {
    // The Charge stands with a null `stripeInvoiceItemId`. Visible on the
    // lease, chargeable by hand, and not an invoice item at Stripe naming a
    // charge that does not exist.
    console.error(`[rubs] failed to push charge ${charge.id}`, error)
  }
}

const UTILITY_LABELS: Record<string, string> = {
  ELECTRIC: 'Electricity',
  GAS: 'Gas',
  WATER: 'Water',
  SEWER: 'Sewer',
  TRASH: 'Trash',
  OTHER: 'Utilities',
}

export function utilityLabel(type: string): string {
  return UTILITY_LABELS[type] ?? type
}

/// The bills at a property, newest period first, with what each split into.
export async function utilityBillsForProperty(propertyId: string) {
  return prisma.utilityBill.findMany({
    where: { propertyId },
    orderBy: [{ periodEnd: 'desc' }, { createdAt: 'desc' }],
    take: 24,
    select: {
      id: true,
      utilityType: true,
      provider: true,
      periodStart: true,
      periodEnd: true,
      amountCents: true,
      method: true,
      allocatedAt: true,
      landlordCents: true,
      documentId: true,
      allocatedBy: { select: { name: true } },
      charges: {
        select: {
          id: true,
          amountCents: true,
          description: true,
          lease: { select: { id: true, unit: { select: { name: true } } } },
        },
      },
    },
  })
}

/// What a refusal reads as on screen. Kept here so the page and any later
/// caller say the same thing.
export function allocationSummary(result: AllocationResult): string {
  if (result.outcome === 'allocated') {
    return (
      `Split ${formatCents(result.chargedCents ?? 0)} across ${result.charges?.length ?? 0} ` +
      `occupied ${result.charges?.length === 1 ? 'unit' : 'units'}` +
      ((result.landlordCents ?? 0) > 0
        ? `. ${formatCents(result.landlordCents ?? 0)} stays with the owner — the vacant units' share.`
        : '.')
    )
  }
  return result.detail ?? 'The bill could not be split.'
}
