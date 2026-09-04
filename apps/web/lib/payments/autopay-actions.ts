'use server'

import { billingCycleAnchor } from '@rental/core/billing'
import {
  SWITCH_REFUSALS,
  debitDayDecision,
  debitDayRefusalMessage,
  switchDecision,
} from '@rental/core/payments'
import type { CollectionMethod } from '@rental/core/payments'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import { createPaymentMethodSetup } from '@/lib/billing/provision.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'

// Starting autopay enrolment (PAY-02, R-039a).
//
// A `'use server'` module, so every export here is a client-callable endpoint
// and each one has to re-derive who is asking. `requireTenantWithScope()` is
// that derivation - the client passes NO payer id, deliberately, because an
// id supplied by the caller is an id the caller can change, and this returns
// a Stripe client secret.
//
// STRIPE-HOSTED FIELDS ONLY. What comes back is a SetupIntent client secret
// for the browser's Elements to use; no card or bank number ever reaches this
// product (master PRD §6.6). The confirmation goes from the browser straight
// to Stripe, and we learn it happened from `setup_intent.succeeded` - not
// from the browser, which can be closed the instant after the tenant taps
// confirm.

export interface AutopaySetupState {
  clientSecret?: string
  error?: string
}

export async function startAutopaySetup(): Promise<AutopaySetupState> {
  const { scope } = await requireTenantWithScope()
  if (scope.leaseIds.length === 0) {
    return { error: 'There is no account set up to pay against yet.' }
  }

  // Scoped by BOTH the tenant and their own leases. Either alone would be a
  // hole: leases without the tenant would hand back a co-tenant's payer, and
  // the tenant without leases would reach a payer on a lease they have since
  // left.
  const payer = await prisma.leasePayer.findFirst({
    where: {
      leaseId: { in: [...scope.leaseIds] },
      tenantId: scope.tenantId,
      active: true,
    },
    select: { id: true, stripeCustomerId: true },
  })
  if (!payer?.stripeCustomerId) {
    // Not an error the tenant caused and not one they can fix. Billing is
    // provisioned when a lease goes live; a payer without a customer means
    // that has not happened yet.
    return { error: 'Automatic payments are not available on this account yet.' }
  }

  const setup = await createPaymentMethodSetup(payer.id)
  if (!setup) return { error: 'Automatic payments are not available on this account yet.' }

  return { clientSecret: setup.clientSecret }
}

/**
 * Move the day autopay pulls (PAY-02, R-039a; D-4).
 *
 * The tenant's own choice, inside the grace period the property's versioned
 * jurisdiction rule allows. Rent due on the 1st and paid on the 3rd is the
 * ordinary case; autopay firing on the 1st against an empty account produces
 * a failed debit, a returned-payment fee and a phone call, every month.
 *
 * The ceiling is enforced in core (`debitDayDecision`) and again here rather
 * than only on the screen: a day past grace guarantees a late fee, and
 * offering a choice that silently charges for itself is worse than offering
 * none.
 */
export async function setDebitDay(
  _previous: { error?: string; saved?: boolean },
  formData: FormData,
): Promise<{ error?: string; saved?: boolean }> {
  const { scope } = await requireTenantWithScope()
  const debitDay = Number(formData.get('debitDay'))

  const payer = await prisma.leasePayer.findFirst({
    where: { leaseId: { in: [...scope.leaseIds] }, tenantId: scope.tenantId, active: true },
    select: {
      id: true,
      stripeSubscriptionId: true,
      lease: {
        select: {
          rentDueDay: true,
          property: { select: { state: true, county: true, timezone: true } },
        },
      },
    },
  })
  if (!payer) return { error: 'There is no account set up to pay against yet.' }

  const rule = await rulesFor(
    { state: payer.lease.property.state, county: payer.lease.property.county },
    new Date(),
  ).catch(() => null)

  const decision = debitDayDecision({
    debitDay,
    rentDueDay: payer.lease.rentDueDay,
    // No configured rule means no grace to spend, so the only safe day is the
    // due day itself. Refusing to guess a grace period is the same posture
    // late fees and deposits take (D-4).
    graceDays: rule?.graceDays ?? 0,
  })
  if (!decision.allowed) {
    return { error: debitDayRefusalMessage(decision.refusal!, decision.latestSafeDay) }
  }

  await prisma.leasePayer.update({
    where: { id: payer.id },
    data: { debitDay },
  })

  // MOVE THE SUBSCRIPTION TOO, or this is a preference the product records
  // and does not act on - which is worse than not offering the choice.
  //
  // Never throws into the tenant's response: the choice IS saved, the
  // pre-debit notice already reads it, and a provider being unreachable must
  // not make a saved setting look rejected. A resync (R-036) reconciles the
  // anchor afterwards.
  if (payer.stripeSubscriptionId) {
    const anchor = billingCycleAnchor({
      rentDueDay: debitDay,
      timezone: payer.lease.property.timezone,
      // From now: the next occurrence of the chosen day. Never backdated -
      // an anchor in the past is a subscription that bills immediately.
      notBefore: new Date(),
    })
    await getBillingProvider()
      .setBillingAnchor({ stripeSubscriptionId: payer.stripeSubscriptionId, anchor })
      .catch((error: unknown) => {
        console.error(`[autopay] failed to move the anchor for payer ${payer.id}`, error)
      })
  }

  return { saved: true }
}

/**
 * Turning autopay off, from the portal (R-164, D-29).
 *
 * The tenant's own switch to `send_invoice` - `switchCollectionMethod` in
 * lib/payments/collection.ts is the same decision and the same push-first
 * order, gated for a staff member acting on any payer. This is that logic
 * for a tenant acting on their own, one payer they cannot choose (found the
 * same way `setDebitDay` finds it), and no free-text reason - "I turned my
 * own autopay off" needs no explanation the way a staff override does.
 *
 * D-36's refusal (Stripe will not invoice a customer with no email) is
 * unchanged and reached through the same `switchDecision` - a tenant with no
 * email on file gets the same sentence a staff member would.
 */
export async function turnOffAutopay(): Promise<{ error?: string; notice?: string }> {
  const { scope } = await requireTenantWithScope()

  const payer = await prisma.leasePayer.findFirst({
    where: { leaseId: { in: [...scope.leaseIds] }, tenantId: scope.tenantId, active: true },
    select: {
      id: true,
      leaseId: true,
      propertyId: true,
      collectionMethod: true,
      collectionPaused: true,
      stripeSubscriptionId: true,
      tenant: { select: { email: true } },
    },
  })
  if (!payer) return { error: 'There is no account set up to pay against yet.' }

  const provider = getBillingProvider()
  let openInvoiceAmountCents: number | null = null
  if (payer.stripeSubscriptionId) {
    try {
      openInvoiceAmountCents = await provider.getOpenInvoiceAmountCents({
        stripeSubscriptionId: payer.stripeSubscriptionId,
      })
    } catch (error) {
      // Left null, which the decision refuses on - a provider we could not
      // reach is not evidence that nothing is owed.
      console.error(`[autopay] could not read open invoices for ${payer.id}`, error)
    }
  }

  const inFlight = await prisma.payment.count({
    where: { leasePayerId: payer.id, status: 'PENDING' },
  })

  const decision = switchDecision({
    current: payer.collectionMethod as CollectionMethod,
    target: 'send_invoice',
    hasSubscription: payer.stripeSubscriptionId != null,
    collectionPaused: payer.collectionPaused,
    payerHasEmail: Boolean(payer.tenant?.email?.trim()),
    paymentsInFlight: inFlight,
    openInvoiceAmountCents,
  })

  if (decision.alreadySet) return { notice: 'Automatic payments are already off.' }
  if (!decision.allowed) return { error: SWITCH_REFUSALS[decision.refusal!] }

  try {
    await provider.setCollectionMethod({
      stripeSubscriptionId: payer.stripeSubscriptionId!,
      collectionMethod: 'send_invoice',
    })
  } catch (error) {
    console.error(`[autopay] could not turn off autopay for ${payer.id}`, error)
    return {
      error: 'The billing provider could not be reached. Nothing has changed — try again shortly.',
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.leasePayer.update({
      where: { id: payer.id },
      data: { collectionMethod: 'send_invoice' },
    })
    await audit(
      {
        action: 'payment.collection_method_changed',
        entityType: 'LeasePayer',
        entityId: payer.id,
        propertyId: payer.propertyId,
        before: { collectionMethod: payer.collectionMethod },
        after: { collectionMethod: 'send_invoice', provider: provider.name },
        reason: 'Turned off from the tenant portal',
      },
      tx,
    )
  })

  revalidatePath('/portal/pay')
  return { notice: 'Automatic payments are off. You can pay what you owe any time from this page.' }
}
