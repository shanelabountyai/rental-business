'use server'

import { PET_MONEY_REFUSAL, petMoneyAllowed } from '@rental/core/accommodations'
import { validateRecurringCharge } from '@rental/core/billing'
import { dollarsToCents, formatCents } from '@rental/core/money'
import { utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { hasApprovedAssistanceAnimal } from '@/lib/accommodations/queries.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { createRecurringCharge, deactivateRecurringCharge } from './recurring.ts'

// Agreeing and ending a monthly charge (PAY-08, R-042).
//
// `lease.write`, NOT `ledger.adjust`. Pet rent and a flat utility fee are
// TERMS OF THE TENANCY - the same kind of fact as the rent amount, which
// `updateLeaseTerms` has always gated on `lease.write`. `ledger.adjust` is
// the privileged permission for recording money that arrived off the rails,
// where there is no processor on the other side to disagree; that is a
// different risk and gating this on it would lock the people whose job this
// is out of doing it, which is the exact mistake R-040's waiver made.

export interface RecurringChargeFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

export async function addRecurringCharge(
  leaseId: string,
  _previous: RecurringChargeFormState,
  formData: FormData,
): Promise<RecurringChargeFormState> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      startsOn: true,
      property: { select: { id: true, legalEntityId: true } },
    },
  })
  await requirePermission('lease.write', propertyResource(lease.property))

  const type = String(formData.get('type') ?? '')
  const label = String(formData.get('label') ?? '')
  const amountDollars = String(formData.get('amountDollars') ?? '').trim()
  // Defaults to the lease's own start, which is right for the ordinary case:
  // pet rent agreed at signing runs from day one. `@db.Date`, so
  // `utcToBusinessDate` - a calendar day never goes through a timezone.
  const startsOn = String(formData.get('startsOn') ?? '') || utcToBusinessDate(lease.startsOn)
  const endsOn = String(formData.get('endsOn') ?? '').trim() || null

  // R-086 (RISK-13). BEFORE anything is validated or priced, because the
  // answer does not depend on the amount: an assistance animal is not a pet,
  // so no pet rent may attach to this tenancy at any figure.
  //
  // `petMoneyAllowed` names all three pet-money types, including the two
  // nothing writes yet - see PET_MONEY_TYPES in packages/core/accommodations
  // for why the rule lives there rather than as a condition here.
  if (type === 'PET_RENT' && !petMoneyAllowed(await hasApprovedAssistanceAnimal(leaseId))) {
    return { error: PET_MONEY_REFUSAL, fieldErrors: { type: 'Not on this tenancy.' } }
  }

  const amount = Number(amountDollars)
  if (!amountDollars || !Number.isFinite(amount)) {
    return {
      error: 'Enter the monthly amount.',
      fieldErrors: { amountDollars: 'A number, in dollars — 35 or 35.00.' },
    }
  }

  // Core decides whether this is a charge the product will bill, and what the
  // tenant will read. Every rule about it lives there and is unit-tested
  // without a database.
  const decision = validateRecurringCharge({
    type,
    amountCents: dollarsToCents(amount),
    label,
    startsOn,
    endsOn,
  })
  if (!decision.ok) {
    return { error: decision.error, fieldErrors: { [decision.field]: decision.error } }
  }

  const created = await createRecurringCharge({
    leaseId: lease.id,
    propertyId: lease.propertyId,
    type: decision.type,
    amountCents: dollarsToCents(amount),
    label,
    startsOn,
    endsOn,
  })

  await audit({
    action: 'lease.updated',
    entityType: 'RecurringCharge',
    entityId: created.id,
    propertyId: lease.propertyId,
    after: {
      leaseId: lease.id,
      type: decision.type,
      amountCents: created.amountCents,
      description: created.description,
      startsOn,
      endsOn,
    },
  })

  revalidatePath(`/leases/${lease.id}`)
  return {
    notice: `${created.description} — added${
      endsOn ? `, ending ${endsOn}` : ''
    }. It bills with the rent from ${startsOn}.`,
  }
}

export async function endRecurringCharge(
  _previous: RecurringChargeFormState,
  formData: FormData,
): Promise<RecurringChargeFormState> {
  // From the form, not a bound argument - one action for every row, the shape
  // R-040's waiver learned the hard way. A Record of bound actions does not
  // survive the Server→Client boundary.
  const id = String(formData.get('recurringChargeId') ?? '')
  if (!id) return { error: 'Nothing was selected to end.' }

  const charge = await prisma.recurringCharge.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      leaseId: true,
      propertyId: true,
      description: true,
      amountCents: true,
      active: true,
      property: { select: { id: true, legalEntityId: true } },
    },
  })
  await requirePermission('lease.write', propertyResource(charge.property))

  if (!charge.active) return { notice: 'That charge has already stopped.' }

  await deactivateRecurringCharge(charge.id)

  await audit({
    action: 'lease.updated',
    entityType: 'RecurringCharge',
    entityId: charge.id,
    propertyId: charge.propertyId,
    before: { active: true },
    after: { active: false, description: charge.description },
  })

  revalidatePath(`/leases/${charge.leaseId}`)
  return {
    notice: `Stopped ${charge.description}. The period already invoiced stands — ${formatCents(
      charge.amountCents,
    )} will not appear on the next invoice.`,
  }
}
