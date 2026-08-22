'use server'

import { businessDateToUtc } from '@rental/core/scheduling'
import { type PropertyReserveInput, validatePropertyReserve } from '@rental/core/property'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'

// The reserve target and last-counted balance (PAY-11, R-082). Both figures
// are typed in - see `PropertyReserve`'s schema comment for why the balance is
// not derived from cash this product cannot see.

export interface FormState {
  error?: string
  fieldErrors?: Record<string, string>
  saved?: boolean
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function cents(formData: FormData, name: string): number | null {
  const raw = str(formData, name)
  if (!raw) return null
  const dollars = Number(raw)
  if (Number.isNaN(dollars)) return Number.NaN
  return Math.round(dollars * 100)
}

export async function setPropertyReserve(
  propertyId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, legalEntityId: true },
  })
  if (!property) return { error: 'That property no longer exists.' }
  const actor = await requirePermission('property.write', propertyResource(property))

  const input: PropertyReserveInput = {
    targetCents: cents(formData, 'targetDollars'),
    balanceCents: cents(formData, 'balanceDollars'),
    balanceAsOf: str(formData, 'balanceAsOf') || null,
  }
  const violations = validatePropertyReserve(input)
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  const data = {
    targetCents: input.targetCents as number,
    balanceCents: input.balanceCents,
    // `@db.Date`: the day it was counted, and no zone may touch a calendar
    // day. Cleared alongside the balance - a date left behind after the
    // balance is removed would date a figure that is no longer there.
    balanceAsOf: input.balanceAsOf ? businessDateToUtc(input.balanceAsOf) : null,
    notes: str(formData, 'notes') || null,
    updatedByStaffId: actor.id,
  }

  // Upsert on the unique `propertyId`: a property has one reserve, and
  // re-entering it corrects the figure rather than stacking a second row that
  // the report would then have to choose between.
  await prisma.propertyReserve.upsert({
    where: { propertyId },
    create: { propertyId, ...data },
    update: data,
  })

  revalidatePath('/reports/reserves')
  return { saved: true }
}
