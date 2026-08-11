'use server'

import { formatCents } from '@rental/core/money'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { checkMonetaryAuthority } from '@rental/core/rbac'
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
  _previous: WaiverFormState,
  formData: FormData,
): Promise<WaiverFormState> {
  // The charge id comes from the FORM, not from a bound argument.
  //
  // Binding one action per fee meant handing a client component a Record of
  // server actions, and the identities did not survive the boundary - the
  // control rendered with no accessible name and no handler. One action plus
  // a hidden field is the shape that works, and it is no less safe: the id is
  // untrusted either way, and every check below runs against the charge that
  // was actually named, including the permission check on ITS property.
  const chargeId = String(formData.get('chargeId') ?? '')
  const reason = String(formData.get('reason') ?? '').trim()
  if (!chargeId) return { error: 'Nothing was selected to waive.' }

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

  // `fee.waive`, NOT `ledger.adjust`.
  //
  // The first version of this used `ledger.adjust`, which was wrong in a way
  // worth recording: the manager role's own description says it "cannot
  // adjust the ledger", and R-004 created a SEPARATE `fee.waive` permission
  // and granted it to managers precisely because forgiving a late fee is
  // day-to-day work. Gating it on `ledger.adjust` locked the people whose
  // job this is out of doing it, which an e2e test found immediately by
  // failing to locate the button.
  const actor = await requirePermission('fee.waive', propertyResource(charge.property))

  // AND a monetary ceiling, which R-004 also built and nothing had ever
  // called: `waive_fee` is one of two MonetaryActions, and every role carries
  // a `defaultWaiveFeeCents` (a manager's is $100). A permission says whether
  // you may waive at all; the ceiling says how much - and without this a
  // manager could forgive a $2,000 fee that the same role could not approve
  // as a work order.
  const authority = checkMonetaryAuthority(actor, 'waive_fee', charge.amountCents)
  if (authority.outcome === 'escalate') {
    // Says the actual numbers. "Above your limit" leaves somebody guessing
    // whether they are $5 or $500 over, and the answer changes what they do
    // next.
    return {
      error: `That fee is ${formatCents(charge.amountCents)} and you can waive up to ${formatCents(authority.ceilingCents)} on your own. Ask an owner to waive this one.`,
    }
  }
  if (authority.outcome === 'denied') {
    return { error: 'You cannot waive fees. Ask a manager or the owner.' }
  }

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
          // What their ceiling was ON THE DAY. Ceilings change, and "was
          // this person allowed to do that" cannot be reconstructed later
          // from a role that has since been edited.
          // `allowed` carries no ceiling - it is the owner's unlimited case
          // or a figure at or under the limit. Recorded as null rather than
          // invented, because a number nobody stated is worse than none.
          ceilingCents: null,
        },
        reason,
      },
      tx,
    )
  })

  revalidatePath(`/leases/${charge.leaseId}`)
  return { notice: `Waived ${formatCents(charge.amountCents)}.` }
}
