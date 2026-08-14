'use server'

import { debitDayDecision, debitDayRefusalMessage } from '@rental/core/payments'
import { createPaymentMethodSetup } from '@/lib/billing/provision.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { prisma } from '@rental/db'
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
      lease: {
        select: {
          rentDueDay: true,
          property: { select: { state: true, county: true } },
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
  return { saved: true }
}
