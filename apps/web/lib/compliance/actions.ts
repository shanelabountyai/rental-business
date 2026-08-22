'use server'

import { createHash } from 'node:crypto'
import { ENTITY_LEVEL_TYPES, isComplianceItemType, nextComplianceDueDate } from '@rental/core/compliance'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Writes for the compliance calendar (PROP-05, R-077). `property.write`,
// the same permission the rest of the filing cabinet already uses
// (Mortgage/InsurancePolicy/Warranty, R-015) - this is the identical class
// of operational property/entity record.

export interface ComplianceFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

export async function createComplianceItem(
  _previous: ComplianceFormState,
  formData: FormData,
): Promise<ComplianceFormState> {
  const type = str(formData, 'type')
  const label = str(formData, 'label')
  const dueOn = str(formData, 'dueOn')
  const recurrenceMonthsRaw = str(formData, 'recurrenceMonths')
  const leadTimeDaysRaw = str(formData, 'leadTimeDays')
  const propertyId = str(formData, 'propertyId') || null
  const legalEntityId = str(formData, 'legalEntityId') || null

  const fieldErrors: Record<string, string> = {}
  if (!isComplianceItemType(type)) fieldErrors.type = 'Choose a type.'
  if (!label) fieldErrors.label = 'Required.'
  if (!dueOn || Number.isNaN(new Date(`${dueOn}T00:00:00.000Z`).getTime())) {
    fieldErrors.dueOn = 'Enter a valid date.'
  }
  const entityLevel = isComplianceItemType(type) && ENTITY_LEVEL_TYPES.has(type)
  if (entityLevel && !legalEntityId) fieldErrors.legalEntityId = 'Choose the entity this belongs to.'
  if (!entityLevel && !propertyId) fieldErrors.propertyId = 'Choose the property this belongs to.'
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  let scopeName: string
  if (entityLevel) {
    const entity = await prisma.legalEntity.findUniqueOrThrow({
      where: { id: legalEntityId! },
      select: { id: true, name: true },
    })
    await requirePermission('property.write', { legalEntityId: entity.id })
    scopeName = entity.name
  } else {
    const property = await prisma.property.findUniqueOrThrow({
      where: { id: propertyId! },
      select: { id: true, legalEntityId: true, name: true },
    })
    await requirePermission('property.write', propertyResource(property))
    scopeName = property.name
  }

  const recurrenceMonths = recurrenceMonthsRaw ? Number(recurrenceMonthsRaw) : null
  const leadTimeDays = leadTimeDaysRaw ? Number(leadTimeDaysRaw) : 30
  if (recurrenceMonths != null && (!Number.isInteger(recurrenceMonths) || recurrenceMonths <= 0)) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: { recurrenceMonths: 'Enter whole months, or leave blank for a one-time item.' },
    }
  }
  if (!Number.isInteger(leadTimeDays) || leadTimeDays < 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: { leadTimeDays: 'Enter a whole number of days.' },
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    const item = await tx.complianceItem.create({
      data: {
        propertyId: entityLevel ? null : propertyId,
        legalEntityId: entityLevel ? legalEntityId : null,
        type,
        label,
        dueOn: new Date(`${dueOn}T00:00:00.000Z`),
        recurrenceMonths,
        leadTimeDays,
      },
    })
    await audit(
      {
        action: 'compliance.item_created',
        entityType: 'ComplianceItem',
        entityId: item.id,
        propertyId: entityLevel ? null : propertyId,
        after: { type, label, dueOn, recurrenceMonths, leadTimeDays, scope: scopeName },
      },
      tx,
    )
    return item
  })

  revalidatePath('/compliance')
  redirect(`/compliance/${created.id}`)
}

/**
 * Records that an obligation was actually satisfied - the permanent log
 * PROP-05 asks for. Advances `dueOn` to the next cycle for a recurring
 * item; a one-time item's own `dueOn` never moves again, and its
 * "done" state is read from whether any completion exists at all.
 */
export async function recordCompletion(
  itemId: string,
  _previous: ComplianceFormState,
  formData: FormData,
): Promise<ComplianceFormState> {
  const item = await prisma.complianceItem.findUniqueOrThrow({
    where: { id: itemId },
    include: {
      property: { select: { id: true, legalEntityId: true } },
      legalEntity: { select: { id: true } },
    },
  })
  const actor = item.property
    ? await requirePermission('property.write', propertyResource(item.property))
    : await requirePermission('property.write', { legalEntityId: item.legalEntity!.id })

  const completedOn = str(formData, 'completedOn')
  if (!completedOn || Number.isNaN(new Date(`${completedOn}T00:00:00.000Z`).getTime())) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: { completedOn: 'Enter a valid date.' },
    }
  }
  const notes = str(formData, 'notes') || null

  await prisma.$transaction(async (tx) => {
    let documentId: string | null = null
    const file = formData.get('file')
    if (file instanceof File && file.size > 0) {
      const buffer = Buffer.from(await file.arrayBuffer())
      const contentType = file.type || 'application/octet-stream'
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      const storageKey = generateStorageKey(item.propertyId ?? item.legalEntityId!, file.name)
      await storage.put(storageKey, buffer, contentType)
      const document = await tx.document.create({
        data: {
          propertyId: item.propertyId,
          // R-081d: an entity-level item (an LLC annual report) has no
          // property, and a document with neither key is refused to every
          // staff member by the file route - so these have been unreachable
          // since R-077. Set both; `ComplianceItem` has always carried the
          // same pair.
          legalEntityId: item.legalEntityId,
          type: 'OTHER',
          fileName: file.name,
          contentType,
          sizeBytes: file.size,
          storageKey,
          sha256,
          uploadedByStaffId: actor.id,
        },
      })
      documentId = document.id
    }

    await tx.complianceCompletion.create({
      data: {
        complianceItemId: item.id,
        completedOn: new Date(`${completedOn}T00:00:00.000Z`),
        completedByStaffId: actor.id,
        documentId,
        notes,
      },
    })

    if (item.recurrenceMonths != null) {
      await tx.complianceItem.update({
        where: { id: item.id },
        data: { dueOn: new Date(`${nextComplianceDueDate(completedOn, item.recurrenceMonths)}T00:00:00.000Z`) },
      })
    }

    await audit(
      {
        action: 'compliance.completed',
        entityType: 'ComplianceItem',
        entityId: item.id,
        propertyId: item.propertyId,
        after: { completedOn, documentId, recurring: item.recurrenceMonths != null },
      },
      tx,
    )
  })

  revalidatePath(`/compliance/${itemId}`)
  revalidatePath('/compliance')
  return { notice: 'Recorded.' }
}
