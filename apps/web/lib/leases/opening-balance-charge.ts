import 'server-only'

import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'

// Pushes an imported lease's opening balance to Stripe (R-168a, PRD §6.8).
//
// `runImport` (lib/import/actions.ts) already wrote the Charge row at
// commit time - a DRAFT lease has no Stripe customer yet, so there was
// nothing to push to then. This is the other half, called once
// `provisionLeaseBilling` has actually opened one: the moment a manually
// activated INHERITED lease gets its first Stripe customer is the moment
// this can run, the same "provision, then push" order the esign-completion
// path already uses for `chargeDeposit`.
//
// STRUCTURALLY THE SAME SHAPE AS `chargeDeposit`: idempotent (an
// already-pushed charge is a no-op), never throws, and a failed push leaves
// the Charge standing rather than an orphaned Stripe reference.
//
// `type: 'OTHER'` is not written anywhere else in this app today (checked
// before choosing it) - the same "none of the codes describe this exactly"
// reasoning `chargeDeposit`'s own `reasonCode: 'other'` already gives. If
// that ever changes, this lookup needs to narrow further than "the lease's
// one un-pushed OTHER charge".

export interface OpeningBalanceChargeResult {
  chargeId: string | null
  amountCents: number
  reason: 'charged' | 'no_balance' | 'already_charged' | 'no_customer' | 'push_failed'
}

export async function chargeOpeningBalance(leaseId: string): Promise<OpeningBalanceChargeResult> {
  const charge = await prisma.charge.findFirst({
    where: { leaseId, type: 'OTHER' },
    select: { id: true, amountCents: true, propertyId: true, stripeInvoiceItemId: true },
  })
  if (!charge) return { chargeId: null, amountCents: 0, reason: 'no_balance' }
  if (charge.stripeInvoiceItemId) {
    return { chargeId: charge.id, amountCents: charge.amountCents, reason: 'already_charged' }
  }

  const payer = await prisma.leasePayer.findFirst({
    where: { leaseId, active: true },
    orderBy: { createdAt: 'asc' },
    select: { stripeCustomerId: true },
  })
  if (!payer?.stripeCustomerId) {
    return { chargeId: charge.id, amountCents: charge.amountCents, reason: 'no_customer' }
  }

  try {
    const item = await getBillingProvider().addInvoiceItem({
      stripeCustomerId: payer.stripeCustomerId,
      amountCents: charge.amountCents,
      currency: 'usd',
      description: 'Opening balance owed at migration',
      chargeId: charge.id,
      // One opening balance per lease - the import writes exactly one such
      // Charge row, at commit, for a given lease.
      idempotencyKey: `opening-balance:${leaseId}`,
    })
    await prisma.charge.update({
      where: { id: charge.id },
      data: { stripeInvoiceItemId: item.stripeInvoiceItemId },
    })
  } catch (error) {
    console.error(`[opening-balance] failed to push charge ${charge.id}`, error)
    return { chargeId: charge.id, amountCents: charge.amountCents, reason: 'push_failed' }
  }

  await auditAsSystem('billing.opening_balance_charge', {
    action: 'ledger.adjusted',
    entityType: 'Charge',
    entityId: charge.id,
    propertyId: charge.propertyId,
    after: { type: 'OTHER', amountCents: charge.amountCents },
    reasonCode: 'other',
    reason: 'Opening balance pushed to Stripe on lease activation (R-168a).',
  }).catch((error: unknown) => {
    console.error(`[opening-balance] failed to audit charge ${charge.id}`, error)
  })

  return { chargeId: charge.id, amountCents: charge.amountCents, reason: 'charged' }
}
