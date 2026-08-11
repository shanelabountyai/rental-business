'use server'

import { formatCents } from '@rental/core/money'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'

// Waiving a fee, and being able to prove it was done evenly (PAY-04, R-040).
//
// A WAIVER IS A CREDIT, NOT A DELETION. The fee was correctly assessed under
// the rule in force that day; forgiving it is a separate decision by a named
// person for a stated reason. Deleting the charge would erase both the fee
// and the fact that somebody chose to forgive it, and the second is the part
// that matters six months later.
//
// The waiver-pattern report ships ALONGSIDE this, in waiver-report.ts, and
// that is deliberate rather than incidental. PAY-04 asks for it and the
// backlog is explicit that it is "part of the feature, not a later analytic".
// The reason is fair housing: waiving fees for some tenants and not others,
// along lines that correlate with a protected class, is a discrimination
// pattern regardless of intent. An operator cannot avoid a pattern they
// cannot see, so the ability to see it ships with the ability to create it.

export interface WaiverFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

export async function waiveCharge(
  chargeId: string,
  _previous: WaiverFormState,
  formData: FormData,
): Promise<WaiverFormState> {
  const reason = String(formData.get('reason') ?? '').trim()

  const charge = await prisma.charge.findUniqueOrThrow({
    where: { id: chargeId },
    select: {
      id: true,
      leaseId: true,
      propertyId: true,
      type: true,
      amountCents: true,
      description: true,
      waivedAt: true,
      property: { select: { id: true, legalEntityId: true } },
      lease: {
        select: {
          leasePayers: {
            where: { active: true },
            select: { stripeCustomerId: true },
            take: 1,
          },
        },
      },
    },
  })

  // `ledger.adjust` - R-004 already treats it as privileged. Forgiving money
  // owed is exactly the kind of thing that needs a named actor on it.
  const actor = await requirePermission('ledger.adjust', propertyResource(charge.property))

  if (!reason) {
    // REQUIRED, and not bureaucracy. "Why was this waived" is the first
    // question in a fair-housing review, and an empty reason column across a
    // hundred waivers is indistinguishable from an arbitrary pattern.
    return {
      error: 'Say why this is being waived.',
      fieldErrors: { reason: 'A short note — "first late payment in two years", for example.' },
    }
  }
  if (charge.waivedAt) {
    return { notice: 'That charge has already been waived.' }
  }

  const payer = charge.lease.leasePayers[0]
  if (payer?.stripeCustomerId) {
    try {
      // A NEGATIVE invoice item: Stripe's own mechanism for a credit, which
      // keeps Stripe the system of record for what is owed (D-11). Waiving
      // only in our own tables would leave Stripe still collecting it.
      await getBillingProvider().addInvoiceItem({
        stripeCustomerId: payer.stripeCustomerId,
        amountCents: -charge.amountCents,
        currency: 'usd',
        description: `Waived: ${charge.description}`,
        idempotencyKey: `waive:${charge.id}`,
      })
    } catch (error) {
      console.error(`[waiver] could not credit charge ${charge.id}`, error)
      return {
        error:
          'The credit could not be sent to the billing provider, so nothing has been waived. Try again shortly.',
      }
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.charge.update({
      where: { id: charge.id },
      data: { waivedAt: new Date(), waivedByStaffId: actor.id, waiveReason: reason },
    })
    await audit(
      {
        action: 'fee.waived',
        entityType: 'Charge',
        entityId: charge.id,
        propertyId: charge.propertyId,
        before: { waivedAt: null },
        after: {
          type: charge.type,
          amountCents: charge.amountCents,
          waivedByStaffId: actor.id,
        },
        reason,
      },
      tx,
    )
  })

  revalidatePath(`/leases/${charge.leaseId}`)
  return { notice: `Waived ${formatCents(charge.amountCents)}.` }
}
