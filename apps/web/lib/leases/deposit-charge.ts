import 'server-only'

import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'

// The deposit charge, created the moment a lease goes live (LEASE-06, R-063
// - the backlog row's own words: "on execution the rent schedule and
// deposit charge create themselves"). `provisionLeaseBilling` (R-034/R-036)
// already covers the rent schedule; this is that item's own missing half.
//
// STRUCTURALLY THE SAME SHAPE AS `chargeMoveInProration` (R-042): the
// Charge row is created FIRST so its id rides into Stripe's metadata, and a
// failed push leaves the Charge standing with a null `stripeInvoiceItemId`
// rather than an invoice item in Stripe naming a charge that does not
// exist.
//
// A CHARGE, NOT A `Deposit` ROW. `Deposit.heldCents` means funds actually
// HELD - a liability that becomes real once payment clears, which R-069's
// "door codes withheld until move-in funds show cleared" is the item that
// checks. Creating a Deposit row here, before any money has moved, would
// make the liability real by construction rather than by an actual cleared
// payment - see this item's own PROGRESS entry for the gap this leaves.
//
// ZERO-DEPOSIT LEASES ARE COMMON AND NOT AN ERROR. `Lease.depositCents`
// defaults to 0, and a surety-bond or no-deposit lease (R-041) legitimately
// owes nothing - this returns `no_deposit` rather than creating a $0 charge
// nobody would ever expect to see on a ledger.

export interface DepositChargeResult {
  chargeId: string | null
  amountCents: number
  reason: 'charged' | 'no_deposit' | 'already_charged' | 'no_customer' | 'push_failed'
}

export async function chargeDeposit(leaseId: string): Promise<DepositChargeResult> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      depositCents: true,
      depositArrangement: true,
      startsOn: true,
      leasePayers: { select: { id: true, stripeCustomerId: true }, take: 1 },
    },
  })

  // NONE/SURETY_BOND holds zero by the database CHECK constraint already
  // (see Lease.depositArrangement's own comment) - this is the same fact,
  // read the cheap way, without a second query.
  if (lease.depositArrangement !== 'CASH' || lease.depositCents <= 0) {
    return { chargeId: null, amountCents: 0, reason: 'no_deposit' }
  }

  const existing = await prisma.charge.findFirst({
    where: { leaseId, type: 'DEPOSIT' },
    select: { id: true, amountCents: true },
  })
  if (existing) {
    return { chargeId: existing.id, amountCents: existing.amountCents, reason: 'already_charged' }
  }

  const payer = lease.leasePayers[0]
  if (!payer) return { chargeId: null, amountCents: 0, reason: 'no_customer' }

  const charge = await prisma.charge.create({
    data: {
      propertyId: lease.propertyId,
      leaseId: lease.id,
      type: 'DEPOSIT',
      amountCents: lease.depositCents,
      description: 'Security deposit',
      dueOn: lease.startsOn,
    },
  })

  if (!payer.stripeCustomerId) {
    return { chargeId: charge.id, amountCents: charge.amountCents, reason: 'no_customer' }
  }

  try {
    const item = await getBillingProvider().addInvoiceItem({
      stripeCustomerId: payer.stripeCustomerId,
      amountCents: lease.depositCents,
      currency: 'usd',
      description: 'Security deposit',
      chargeId: charge.id,
      // One deposit per lease, matching chargeMoveInProration's own key
      // shape.
      idempotencyKey: `deposit:${lease.id}`,
    })
    await prisma.charge.update({
      where: { id: charge.id },
      data: { stripeInvoiceItemId: item.stripeInvoiceItemId },
    })
  } catch (error) {
    console.error(`[deposit] failed to push charge ${charge.id}`, error)
    return { chargeId: charge.id, amountCents: charge.amountCents, reason: 'push_failed' }
  }

  await auditAsSystem('billing.deposit_charge', {
    action: 'ledger.adjusted',
    entityType: 'Charge',
    entityId: charge.id,
    propertyId: lease.propertyId,
    after: { type: 'DEPOSIT', amountCents: lease.depositCents },
    // `ledger.adjusted` is in REASON_REQUIRED - a `reasonCode` satisfies
    // `recordAudit` the same as a free-text reason would (see its own
    // check). 'other' is the honest choice: none of the codes describe "a
    // deposit was charged because a lease went live", and inventing one
    // that half-fits would be worse than the generic one.
    reasonCode: 'other',
    reason: 'Deposit charge created automatically on lease execution (R-063).',
  }).catch((error: unknown) => {
    console.error(`[deposit] failed to audit charge ${charge.id}`, error)
  })

  return { chargeId: charge.id, amountCents: charge.amountCents, reason: 'charged' }
}
