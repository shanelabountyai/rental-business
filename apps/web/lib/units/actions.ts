'use server'

import { type UnitInput, validateUnit } from '@rental/core/units'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'

// Writes for Unit (PROP-02). Same shape as packages/properties/actions.ts:
// permission checks always carry the resource being acted on, and every
// mutation is audited inside the same transaction as the write.

export interface FormState {
  error?: string
  fieldErrors?: Record<string, string>
}

function violationsToState(
  violations: readonly { field: string; message: string }[],
): FormState {
  return {
    error: 'Fix the highlighted fields.',
    fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
  }
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/// Blank -> null, unparseable -> NaN (never silently 0) - see
/// packages/core/property/validate.ts's identical helper and the NaN-range-
/// check pairing it depends on.
function optionalNumber(formData: FormData, name: string): number | null {
  const raw = str(formData, name)
  return raw ? Number(raw) : null
}

function unitInputFrom(propertyId: string, formData: FormData): UnitInput {
  // The form collects whole dollars (friendlier to type than cents); the
  // conversion to integer cents happens once, here, at the write boundary -
  // money is integer cents everywhere past this point (D-3).
  const marketDollars = optionalNumber(formData, 'marketDollars')

  return {
    propertyId,
    name: str(formData, 'name'),
    status: str(formData, 'status'),
    marketRentCents: marketDollars != null ? Math.round(marketDollars * 100) : null,
    bedrooms: optionalNumber(formData, 'bedrooms'),
    bathrooms: optionalNumber(formData, 'bathrooms'),
    squareFeet: optionalNumber(formData, 'squareFeet'),
    notes: str(formData, 'notes') || null,
  }
}

export async function createUnit(
  propertyId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
  })
  await requirePermission('unit.write', propertyResource(property))

  const input = unitInputFrom(propertyId, formData)
  const violations = validateUnit(input)
  if (violations.length > 0) return violationsToState(violations)

  const unit = await prisma.$transaction(async (tx) => {
    const created = await tx.unit.create({
      data: {
        propertyId,
        name: input.name,
        status: input.status as never,
        marketRentCents: input.marketRentCents,
        bedrooms: input.bedrooms,
        bathrooms: input.bathrooms,
        squareFeet: input.squareFeet,
        notes: input.notes,
      },
    })
    await audit(
      {
        action: 'unit.created',
        entityType: 'Unit',
        entityId: created.id,
        propertyId,
        after: {
          name: created.name,
          status: created.status,
          marketRentCents: created.marketRentCents,
        },
      },
      tx,
    )
    return created
  })

  revalidatePath(`/properties/${propertyId}`)
  redirect(`/properties/${propertyId}/units/${unit.id}`)
}

export async function updateUnit(
  propertyId: string,
  unitId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const [property, existing] = await Promise.all([
    prisma.property.findUniqueOrThrow({ where: { id: propertyId } }),
    prisma.unit.findUniqueOrThrow({ where: { id: unitId } }),
  ])
  await requirePermission('unit.write', propertyResource(property))

  const input = unitInputFrom(propertyId, formData)
  const violations = validateUnit(input)
  if (violations.length > 0) return violationsToState(violations)

  await prisma.$transaction(async (tx) => {
    const updated = await tx.unit.update({
      where: { id: unitId },
      data: {
        name: input.name,
        status: input.status as never,
        marketRentCents: input.marketRentCents,
        bedrooms: input.bedrooms,
        bathrooms: input.bathrooms,
        squareFeet: input.squareFeet,
        notes: input.notes,
      },
    })
    await audit(
      {
        action: 'unit.updated',
        entityType: 'Unit',
        entityId: unitId,
        propertyId,
        before: {
          name: existing.name,
          status: existing.status,
          marketRentCents: existing.marketRentCents,
        },
        after: {
          name: updated.name,
          status: updated.status,
          marketRentCents: updated.marketRentCents,
        },
      },
      tx,
    )
  })

  revalidatePath(`/properties/${propertyId}`)
  revalidatePath(`/properties/${propertyId}/units/${unitId}`)
  redirect(`/properties/${propertyId}/units/${unitId}`)
}
