'use server'

import { type ListingInput, validateListing } from '@rental/core/listings'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'

// Writes for Listing (LEASE-01, R-056). Same shape as units/actions.ts: a
// resource-carrying permission check first, then a transaction pairing the
// write with its audit entry. `unit.write` is the permission this reuses -
// a listing is a fact ABOUT a unit, not its own privilege tier, and adding
// one would be RBAC surface nobody asked for.

export interface FormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
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

/// Blank -> null, unparseable -> NaN (never silently 0) - matches
/// apps/web/lib/units/actions.ts's identical helper.
function optionalCents(formData: FormData, name: string): number | null {
  const raw = str(formData, name)
  if (!raw) return null
  return Math.round(Number(raw) * 100)
}

function requiredCents(formData: FormData, name: string): number {
  const raw = str(formData, name)
  return raw ? Math.round(Number(raw) * 100) : Number.NaN
}

/// Date-only, UTC midnight - `Listing.availableOn` is `@db.Date`, matching
/// every other calendar-day field in this codebase (see leases/validate.ts's
/// identical parser and comment).
function parseDateOnly(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim())
  if (!match) return null
  const [, y, m, d] = match
  const date = new Date(Date.UTC(+y!, +m! - 1, +d!))
  return Number.isNaN(date.getTime()) ? null : date
}

function listingInputFrom(unitId: string, formData: FormData): ListingInput {
  return {
    unitId,
    headline: str(formData, 'headline') || null,
    description: str(formData, 'description') || null,
    rentCents: requiredCents(formData, 'rentDollars'),
    depositCents: optionalCents(formData, 'depositDollars'),
    availableOn: parseDateOnly(str(formData, 'availableOn')),
    requirements: str(formData, 'requirements') || null,
    petsAllowed: formData.get('petsAllowed') === 'on',
    petPolicyText: str(formData, 'petPolicyText') || null,
  }
}

export async function createListing(
  unitId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const unit = await prisma.unit.findUniqueOrThrow({
    where: { id: unitId },
    include: { property: true },
  })
  const actor = await requirePermission('unit.write', propertyResource(unit.property))

  const input = listingInputFrom(unitId, formData)
  const violations = validateListing(input)
  if (violations.length > 0) return violationsToState(violations)

  const listing = await prisma.$transaction(async (tx) => {
    const created = await tx.listing.create({
      data: {
        propertyId: unit.propertyId,
        unitId,
        headline: input.headline,
        description: input.description,
        rentCents: input.rentCents,
        depositCents: input.depositCents,
        availableOn: input.availableOn!,
        requirements: input.requirements,
        petsAllowed: input.petsAllowed,
        petPolicyText: input.petPolicyText,
        createdByStaffId: actor.id,
      },
    })
    await audit(
      {
        action: 'listing.created',
        entityType: 'Listing',
        entityId: created.id,
        propertyId: unit.propertyId,
        after: { unitId, rentCents: created.rentCents, status: created.status },
      },
      tx,
    )
    return created
  })

  revalidatePath(`/properties/${unit.propertyId}/units/${unitId}`)
  redirect(`/properties/${unit.propertyId}/units/${unitId}/listing/${listing.id}`)
}

async function listingForWriteOrThrow(listingId: string) {
  const listing = await prisma.listing.findUniqueOrThrow({
    where: { id: listingId },
    include: { property: true },
  })
  await requirePermission('unit.write', propertyResource(listing.property))
  return listing
}

export async function updateListing(
  listingId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const listing = await listingForWriteOrThrow(listingId)

  const input = listingInputFrom(listing.unitId, formData)
  const violations = validateListing(input)
  if (violations.length > 0) return violationsToState(violations)

  const before = {
    headline: listing.headline,
    description: listing.description,
    rentCents: listing.rentCents,
    depositCents: listing.depositCents,
    availableOn: listing.availableOn.toISOString(),
    requirements: listing.requirements,
    petsAllowed: listing.petsAllowed,
    petPolicyText: listing.petPolicyText,
  }
  const after = {
    headline: input.headline,
    description: input.description,
    rentCents: input.rentCents,
    depositCents: input.depositCents,
    availableOn: input.availableOn!.toISOString(),
    requirements: input.requirements,
    petsAllowed: input.petsAllowed,
    petPolicyText: input.petPolicyText,
  }

  await prisma.$transaction(async (tx) => {
    await tx.listing.update({
      where: { id: listingId },
      data: {
        headline: input.headline,
        description: input.description,
        rentCents: input.rentCents,
        depositCents: input.depositCents,
        // Guaranteed non-null: validateListing already rejected a blank or
        // unparseable date above, and nothing here can have written NaN into
        // it since then.
        availableOn: input.availableOn!,
        requirements: input.requirements,
        petsAllowed: input.petsAllowed,
        petPolicyText: input.petPolicyText,
      },
    })
    await audit(
      {
        action: 'listing.updated',
        entityType: 'Listing',
        entityId: listingId,
        propertyId: listing.propertyId,
        before,
        after,
      },
      tx,
    )
  })

  revalidatePath(`/properties/${listing.propertyId}/units/${listing.unitId}`)
  revalidatePath(`/properties/${listing.propertyId}/units/${listing.unitId}/listing/${listingId}`)
  return { notice: 'Saved.' }
}

export async function publishListing(
  listingId: string,
  _previous: FormState,
  _formData: FormData,
): Promise<FormState> {
  const listing = await listingForWriteOrThrow(listingId)

  await prisma.$transaction(async (tx) => {
    await tx.listing.update({
      where: { id: listingId },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    })
    await audit(
      {
        action: 'listing.published',
        entityType: 'Listing',
        entityId: listingId,
        propertyId: listing.propertyId,
        before: { status: listing.status },
        after: { status: 'PUBLISHED' },
      },
      tx,
    )
  })

  revalidatePath(`/properties/${listing.propertyId}/units/${listing.unitId}`)
  revalidatePath(`/properties/${listing.propertyId}/units/${listing.unitId}/listing/${listingId}`)
  revalidatePath(`/listings/${listingId}`)
  return { notice: 'Published.' }
}

export async function unpublishListing(
  listingId: string,
  _previous: FormState,
  _formData: FormData,
): Promise<FormState> {
  const listing = await listingForWriteOrThrow(listingId)

  await prisma.$transaction(async (tx) => {
    await tx.listing.update({
      where: { id: listingId },
      data: { status: 'UNPUBLISHED' },
    })
    await audit(
      {
        action: 'listing.unpublished',
        entityType: 'Listing',
        entityId: listingId,
        propertyId: listing.propertyId,
        before: { status: listing.status },
        after: { status: 'UNPUBLISHED' },
      },
      tx,
    )
  })

  revalidatePath(`/properties/${listing.propertyId}/units/${listing.unitId}`)
  revalidatePath(`/properties/${listing.propertyId}/units/${listing.unitId}/listing/${listingId}`)
  revalidatePath(`/listings/${listingId}`)
  return { notice: 'Unpublished.' }
}
