'use server'

import {
  SWITCH_REFUSALS,
  isCollectionMethod,
  switchDecision,
} from '@rental/core/payments'
import type { CollectionMethod } from '@rental/core/payments'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import type { WorkOrderFormState } from '@/lib/workorders/actions.ts'

// Moving a payer between autopay and invoiced collection (D-29).
//
// ASK STRIPE, THEN DECIDE, THEN ACT - R-036's rule, and it matters more here
// than anywhere else in the product. The hazard D-29 names is an open
// invoice on the old mode that the new mode's subscription then bills again,
// and the only place that fact lives is Stripe. Deciding from our own
// columns would be deciding from what we last believed, which is exactly the
// state a re-sync exists because we cannot trust.
//
// PUSH FIRST, WRITE SECOND. The column is updated only after Stripe accepts
// the change, so a failed push cannot leave us believing a tenant is on a
// payment plan while Stripe is still debiting them automatically.

export async function switchCollectionMethod(
  _previous: WorkOrderFormState,
  formData: FormData,
): Promise<WorkOrderFormState> {
  // From the form, not a bound argument - one action serves every payer on
  // the lease, the shape `endRecurringCharge` settled on. Authorisation is
  // derived FROM this id: the property comes off the payer that was named, so
  // a forged value is checked against its own property rather than the one on
  // screen.
  const leasePayerId = String(formData.get('leasePayerId') ?? '')
  if (!leasePayerId) return { error: 'Choose which payer is changing.' }
  const target = String(formData.get('collectionMethod') ?? '')
  const reason = String(formData.get('reason') ?? '').trim()

  if (!isCollectionMethod(target)) {
    return { error: 'Choose how this payer should be collected from.' }
  }
  if (!reason) {
    // A REASON IS REQUIRED, and it is not bureaucracy. This changes how money
    // is taken from a tenant - moving somebody onto a payment plan, or back
    // off one - and "why" is the first question anybody asks about it three
    // months later, including in a dispute.
    return {
      error: 'Say why this is changing.',
      fieldErrors: { reason: 'A short note — “agreed a payment plan”, for example.' },
    }
  }

  const payer = await prisma.leasePayer.findUniqueOrThrow({
    where: { id: leasePayerId },
    select: {
      id: true,
      leaseId: true,
      propertyId: true,
      collectionMethod: true,
      collectionPaused: true,
      stripeSubscriptionId: true,
      externalPayerName: true,
      tenant: { select: { email: true } },
      property: { select: { id: true, legalEntityId: true } },
    },
  })
  await requirePermission('lease.write', propertyResource(payer.property))

  const provider = getBillingProvider()
  let openInvoiceAmountCents: number | null = null
  if (payer.stripeSubscriptionId) {
    try {
      openInvoiceAmountCents = await provider.getOpenInvoiceAmountCents({
        stripeSubscriptionId: payer.stripeSubscriptionId,
      })
    } catch (error) {
      // Left null, which the decision refuses on. A provider we could not
      // reach is not evidence that nothing is owed.
      console.error(`[payments] could not read open invoices for ${payer.id}`, error)
    }
  }

  const inFlight = await prisma.payment.count({
    where: { leasePayerId: payer.id, status: 'PENDING' },
  })

  const decision = switchDecision({
    current: payer.collectionMethod as CollectionMethod,
    target,
    hasSubscription: payer.stripeSubscriptionId != null,
    collectionPaused: payer.collectionPaused,
    // Stripe refuses `send_invoice` for a customer with no email. Read from
    // the tenant rather than from Stripe: this is a precondition we can check
    // before making a call that would fail, and a refusal a staff member can
    // act on beats a 400 they cannot.
    payerHasEmail: Boolean(payer.tenant?.email?.trim()),
    paymentsInFlight: inFlight,
    openInvoiceAmountCents,
  })

  if (decision.alreadySet) {
    return { notice: 'That is already how this payer is collected from.' }
  }
  if (!decision.allowed) {
    return { error: SWITCH_REFUSALS[decision.refusal!] }
  }

  try {
    await provider.setCollectionMethod({
      stripeSubscriptionId: payer.stripeSubscriptionId!,
      collectionMethod: target,
    })
  } catch (error) {
    console.error(`[payments] could not switch collection for ${payer.id}`, error)
    return {
      error: 'The billing provider could not be reached. Nothing has changed — try again shortly.',
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.leasePayer.update({
      where: { id: payer.id },
      data: { collectionMethod: target },
    })
    await audit(
      {
        action: 'payment.collection_method_changed',
        entityType: 'LeasePayer',
        entityId: payer.id,
        propertyId: payer.propertyId,
        before: { collectionMethod: payer.collectionMethod },
        after: { collectionMethod: target, provider: provider.name },
        reason,
      },
      tx,
    )
  })

  revalidatePath(`/leases/${payer.leaseId}`)
  return {
    notice:
      target === 'send_invoice'
        ? 'Switched to invoiced billing — this payer can now pay part of what they owe.'
        : 'Switched to automatic payments.',
  }
}
