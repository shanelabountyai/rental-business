'use server'

import { createPaymentMethodSetup } from '@/lib/billing/provision.ts'
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
