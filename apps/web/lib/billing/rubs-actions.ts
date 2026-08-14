'use server'

import { isRubsMethod } from '@rental/core/billing'
import { dollarsToCents } from '@rental/core/money'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { allocateBill, allocationSummary } from './rubs.ts'

// Recording a utility bill and charging it on (PAY-08, R-042).
//
// TWO ACTIONS, DELIBERATELY, AND TWO PERMISSIONS. Recording the bill is
// bookkeeping - `property.write`, the same permission that maintains the
// utility accounts on a unit. CHARGING IT ON bills every tenant at the
// property in one press, which is the most consequential single action in the
// money module, so it sits behind `ledger.adjust` - the privileged
// permission R-004 reserves for money that no processor is on the other side
// of.
//
// Splitting is a separate press from recording for the same reason: the
// arithmetic is shown first, against the bill, and somebody says yes. A
// record-and-charge in one step would bill four tenants off a typo in an
// amount field.

export interface UtilityBillFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

export async function recordUtilityBill(
  propertyId: string,
  _previous: UtilityBillFormState,
  formData: FormData,
): Promise<UtilityBillFormState> {
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
    select: { id: true, legalEntityId: true },
  })
  await requirePermission('property.write', propertyResource(property))

  const utilityType = String(formData.get('utilityType') ?? '').trim()
  const method = String(formData.get('method') ?? '')
  const provider = String(formData.get('provider') ?? '').trim() || null
  const periodStart = String(formData.get('periodStart') ?? '')
  const periodEnd = String(formData.get('periodEnd') ?? '')
  const amountDollars = String(formData.get('amountDollars') ?? '').trim()
  const documentId = String(formData.get('documentId') ?? '').trim() || null

  if (!utilityType) {
    return { error: 'Say which utility this is.', fieldErrors: { utilityType: 'Required.' } }
  }
  if (!isRubsMethod(method)) {
    return { error: 'Choose how the bill is split.', fieldErrors: { method: 'Required.' } }
  }
  if (!periodStart || !periodEnd) {
    return {
      error: 'Enter the period the bill covers.',
      fieldErrors: {
        [periodStart ? 'periodEnd' : 'periodStart']: 'Required — it goes on every tenant’s invoice line.',
      },
    }
  }
  if (periodEnd < periodStart) {
    return {
      error: 'The period ends before it starts.',
      fieldErrors: { periodEnd: 'Later than the start date.' },
    }
  }

  const amount = Number(amountDollars)
  if (!amountDollars || !Number.isFinite(amount) || amount <= 0) {
    return {
      error: 'Enter the amount on the bill.',
      fieldErrors: { amountDollars: 'A number, in dollars — 412 or 412.00.' },
    }
  }

  const bill = await prisma.utilityBill.create({
    data: {
      propertyId: property.id,
      utilityType,
      provider,
      // `@db.Date`. Parsed as UTC midnight and never through a timezone — a
      // billing period is a pair of calendar days.
      periodStart: new Date(`${periodStart}T00:00:00.000Z`),
      periodEnd: new Date(`${periodEnd}T00:00:00.000Z`),
      amountCents: dollarsToCents(amount),
      method,
      documentId,
    },
  })

  await audit({
    action: 'property.updated',
    entityType: 'UtilityBill',
    entityId: bill.id,
    propertyId: property.id,
    after: {
      utilityType,
      provider,
      periodStart,
      periodEnd,
      amountCents: bill.amountCents,
      method,
      documentId,
    },
  })

  revalidatePath(`/properties/${property.id}/utilities`)
  return {
    notice: documentId
      ? 'Bill recorded. Check the split below, then charge it on.'
      : 'Bill recorded. Attach the bill itself before charging it on — the arithmetic is only half the defence.',
  }
}

export async function splitUtilityBill(
  _previous: UtilityBillFormState,
  formData: FormData,
): Promise<UtilityBillFormState> {
  const id = String(formData.get('utilityBillId') ?? '')
  if (!id) return { error: 'No bill was named.' }

  const bill = await prisma.utilityBill.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      propertyId: true,
      property: { select: { id: true, legalEntityId: true } },
    },
  })
  // The privileged one. This bills every tenant at the property at once.
  const actor = await requirePermission('ledger.adjust', propertyResource(bill.property))

  const result = await allocateBill(bill.id, actor.id)

  revalidatePath(`/properties/${bill.propertyId}/utilities`)
  return result.outcome === 'allocated'
    ? { notice: allocationSummary(result) }
    : { error: allocationSummary(result) }
}
