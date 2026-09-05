'use server'

import {
  type LegalEntityInput,
  type PropertyInput,
  addressComparisonKey,
  validateLegalEntity,
  validateProperty,
} from '@rental/core/property'
import { prisma } from '@rental/db'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { candidateDuplicateProperties } from './queries.ts'

// Writes for LegalEntity and Property (PROP-01, PROP-04).
//
// Permission checks always pass the RESOURCE being acted on - the entity for
// an entity write, the property for a property write - never a bare
// permission check with nothing to scope against. See R-004's `can()`: a
// property-scoped manager's grant only matches when the resource actually
// names their property, and creating a brand-new property has no propertyId
// yet, so that check is what correctly confines "who may create a property
// under entity X" to portfolio-wide and entity-scoped grants.

export interface FormState {
  error?: string
  fieldErrors?: Record<string, string>
}

function violationsToState(
  violations: readonly { field: string; message: string }[],
): FormState {
  return {
    error: 'Fix the highlighted fields.',
    fieldErrors: Object.fromEntries(
      violations.map((v) => [v.field, v.message]),
    ),
  }
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/// Returns null for a blank field and NaN for anything unparseable, rather
/// than silently coercing garbage to 0 or dropping it. validateProperty()
/// rejects NaN explicitly - a browser <input type=number> cannot submit
/// non-numeric text, but a server action is callable directly, so the
/// server side still has to catch it.
function optionalNumber(formData: FormData, name: string): number | null {
  const raw = str(formData, name)
  return raw ? Number(raw) : null
}

// ---------------------------------------------------------------------------
// Legal entities
// ---------------------------------------------------------------------------

export async function createLegalEntity(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // No resource: per R-004 this only clears for a portfolio-wide grant.
  // Entity-scoped and property-scoped managers cannot mint new entities.
  await requirePermission('property.write')

  const input: LegalEntityInput = {
    name: str(formData, 'name'),
    type: str(formData, 'type'),
    formationState: str(formData, 'formationState') || null,
  }
  const violations = validateLegalEntity(input)
  if (violations.length > 0) return violationsToState(violations)

  const entity = await prisma.$transaction(async (tx) => {
    const created = await tx.legalEntity.create({
      data: {
        name: input.name,
        type: input.type as never,
        formationState: input.formationState,
      },
    })
    await audit(
      {
        action: 'legal_entity.created',
        entityType: 'LegalEntity',
        entityId: created.id,
        after: {
          name: created.name,
          type: created.type,
          formationState: created.formationState,
        },
      },
      tx,
    )
    return created
  })

  revalidatePath('/properties')
  redirect(`/properties?entityCreated=${encodeURIComponent(entity.name)}`)
}

export async function updateLegalEntity(
  entityId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const existing = await prisma.legalEntity.findUniqueOrThrow({
    where: { id: entityId },
  })
  await requirePermission('property.write', { legalEntityId: entityId })

  const input: LegalEntityInput = {
    name: str(formData, 'name'),
    type: str(formData, 'type'),
    formationState: str(formData, 'formationState') || null,
  }
  const violations = validateLegalEntity(input)
  if (violations.length > 0) return violationsToState(violations)

  await prisma.$transaction(async (tx) => {
    const updated = await tx.legalEntity.update({
      where: { id: entityId },
      data: {
        name: input.name,
        type: input.type as never,
        formationState: input.formationState,
      },
    })
    await audit(
      {
        action: 'legal_entity.updated',
        entityType: 'LegalEntity',
        entityId,
        before: {
          name: existing.name,
          type: existing.type,
          formationState: existing.formationState,
        },
        after: {
          name: updated.name,
          type: updated.type,
          formationState: updated.formationState,
        },
      },
      tx,
    )
  })

  revalidatePath('/properties')
  redirect('/properties')
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

function propertyInputFrom(formData: FormData): PropertyInput {
  return {
    legalEntityId: str(formData, 'legalEntityId'),
    name: str(formData, 'name'),
    propertyType: str(formData, 'propertyType'),
    timezone: str(formData, 'timezone'),
    addressLine1: str(formData, 'addressLine1'),
    addressLine2: str(formData, 'addressLine2') || null,
    city: str(formData, 'city'),
    state: str(formData, 'state'),
    postalCode: str(formData, 'postalCode'),
    bedrooms: optionalNumber(formData, 'bedrooms'),
    bathrooms: optionalNumber(formData, 'bathrooms'),
    yearBuilt: optionalNumber(formData, 'yearBuilt'),
    acquiredOn: str(formData, 'acquiredOn') || null,
    historyStartsOn: str(formData, 'historyStartsOn') || null,
    metro: str(formData, 'metro') || null,
    tags: str(formData, 'tags')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    hasPool: formData.get('hasPool') === 'on',
    hasWellOrSeptic: formData.get('hasWellOrSeptic') === 'on',
    moldHistoryNotes: str(formData, 'moldHistoryNotes') || null,
    bedbugHistoryNotes: str(formData, 'bedbugHistoryNotes') || null,
  }
}

export interface PropertyFormState extends FormState {
  /// Set when a same-address property already exists and the form has not
  /// yet been resubmitted with confirmation. The page re-renders the same
  /// values with a "Save anyway" affordance instead of silently creating a
  /// second record (PROP-01).
  duplicateOf?: { id: string; name: string; addressLine1: string } | null
  /// Echoes back whatever was submitted, on every non-redirect return.
  ///
  /// React resets an uncontrolled <form>'s fields after ANY action dispatch,
  /// success or not - not just on error. Without this, a validation failure
  /// or a duplicate warning silently wipes every field the user just typed,
  /// including the required address, at exactly the moment they need to fix
  /// or confirm it. The form re-hydrates from this (see PropertyForm) rather
  /// than trusting the DOM to still hold what was typed.
  submitted?: PropertyInput
}

export async function createProperty(
  _previous: PropertyFormState,
  formData: FormData,
): Promise<PropertyFormState> {
  const input = propertyInputFrom(formData)
  const violations = validateProperty(input)
  if (violations.length > 0) {
    return { ...violationsToState(violations), submitted: input }
  }

  // Checked before the permission gate below settles who may write, because
  // the actor needs to know about a duplicate even if it turns out they
  // cannot create the property at all - the message is more useful than a
  // generic denial in that order.
  const actor = await requirePermission('property.write', {
    legalEntityId: input.legalEntityId,
  })

  const confirmed = formData.get('confirmDuplicate') === 'true'
  if (!confirmed) {
    const key = addressComparisonKey(input)
    const candidates = await candidateDuplicateProperties(actor)
    const duplicate = candidates.find(
      (candidate) => addressComparisonKey(candidate) === key,
    )
    if (duplicate) {
      return {
        duplicateOf: {
          id: duplicate.id,
          name: duplicate.name,
          addressLine1: duplicate.addressLine1,
        },
        submitted: input,
      }
    }
  }

  const property = await prisma.$transaction(async (tx) => {
    const created = await tx.property.create({
      data: {
        legalEntityId: input.legalEntityId,
        name: input.name,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        timezone: input.timezone,
        propertyType: input.propertyType as never,
        bedrooms: input.bedrooms,
        bathrooms: input.bathrooms,
        yearBuilt: input.yearBuilt,
        acquiredOn: input.acquiredOn ? new Date(`${input.acquiredOn}T00:00:00Z`) : null,
        historyStartsOn: input.historyStartsOn ? new Date(`${input.historyStartsOn}T00:00:00Z`) : null,
        metro: input.metro,
        tags: input.tags ?? [],
        hasPool: input.hasPool ?? false,
        hasWellOrSeptic: input.hasWellOrSeptic ?? false,
        moldHistoryNotes: input.moldHistoryNotes,
        bedbugHistoryNotes: input.bedbugHistoryNotes,
      },
    })
    await audit(
      {
        action: 'property.created',
        entityType: 'Property',
        entityId: created.id,
        propertyId: created.id,
        after: {
          legalEntityId: created.legalEntityId,
          name: created.name,
          addressLine1: created.addressLine1,
          city: created.city,
          state: created.state,
          postalCode: created.postalCode,
          timezone: created.timezone,
          propertyType: created.propertyType,
        },
      },
      tx,
    )
    return created
  })

  revalidatePath('/properties')
  redirect(`/properties/${property.id}`)
}

export async function updateProperty(
  propertyId: string,
  _previous: PropertyFormState,
  formData: FormData,
): Promise<PropertyFormState> {
  const existing = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
  })
  // Both ids, not just propertyId - see propertyResource's own comment. An
  // entity-scoped manager editing a property that genuinely belongs to their
  // entity was wrongly denied here until this fix.
  await requirePermission('property.write', propertyResource(existing))

  const input = propertyInputFrom(formData)
  const violations = validateProperty(input)
  if (violations.length > 0) {
    return { ...violationsToState(violations), submitted: input }
  }

  await prisma.$transaction(async (tx) => {
    const updated = await tx.property.update({
      where: { id: propertyId },
      data: {
        name: input.name,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        timezone: input.timezone,
        propertyType: input.propertyType as never,
        bedrooms: input.bedrooms,
        bathrooms: input.bathrooms,
        yearBuilt: input.yearBuilt,
        acquiredOn: input.acquiredOn ? new Date(`${input.acquiredOn}T00:00:00Z`) : null,
        historyStartsOn: input.historyStartsOn ? new Date(`${input.historyStartsOn}T00:00:00Z`) : null,
        metro: input.metro,
        tags: input.tags ?? [],
        hasPool: input.hasPool ?? false,
        hasWellOrSeptic: input.hasWellOrSeptic ?? false,
        moldHistoryNotes: input.moldHistoryNotes,
        bedbugHistoryNotes: input.bedbugHistoryNotes,
      },
    })
    await audit(
      {
        action: 'property.updated',
        entityType: 'Property',
        entityId: propertyId,
        propertyId,
        before: {
          name: existing.name,
          addressLine1: existing.addressLine1,
          city: existing.city,
          state: existing.state,
          postalCode: existing.postalCode,
          timezone: existing.timezone,
          propertyType: existing.propertyType,
        },
        after: {
          name: updated.name,
          addressLine1: updated.addressLine1,
          city: updated.city,
          state: updated.state,
          postalCode: updated.postalCode,
          timezone: updated.timezone,
          propertyType: updated.propertyType,
        },
      },
      tx,
    )
  })

  revalidatePath('/properties')
  revalidatePath(`/properties/${propertyId}`)
  redirect(`/properties/${propertyId}`)
}
