'use server'

import {
  canEditItem,
  canFinishInspection,
  canLockInspection,
  canRecordSignature,
  isInspectionType,
  validateItemRecord,
  type TemplateChecklistItem,
} from '@rental/core/inspections'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'

// Writes for Inspection (INSP-01, R-068). Same shape every other
// lib/*/actions.ts in this repo takes: a resource-carrying permission check
// first, then a transaction pairing the write with its audit entry where
// one is warranted.
//
// PHASE 1 OF THIS ITEM. What this file does NOT do yet, named rather than
// silently missing: no photo capture, no geotagging, no tenant-portal
// e-sign, no auto-finalize job. `canRecordSignature`'s own comment states
// the interim posture - a staff member records that a tenant signed in
// person, on the inspector's own phone.

export interface InspectionFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

async function inspectionForWrite(inspectionId: string) {
  const inspection = await prisma.inspection.findUniqueOrThrow({
    where: { id: inspectionId },
    include: {
      property: { select: { id: true, legalEntityId: true } },
      items: { select: { id: true, condition: true } },
    },
  })
  const actor = await requirePermission('inspection.write', propertyResource(inspection.property))
  return { inspection, actor }
}

/**
 * Starts a new inspection from a checklist template - the only path in
 * phase 1 (no ad hoc room/item entry yet, see this file's own header).
 * `InspectionTemplate.items` is copied wholesale into fresh `InspectionItem`
 * rows, independent of the template from this moment on - editing or
 * retiring the template afterward never reaches an inspection already
 * built from it.
 */
export async function startInspection(
  _previous: InspectionFormState,
  formData: FormData,
): Promise<InspectionFormState> {
  const unitId = str(formData, 'unitId')
  const type = str(formData, 'type')
  const templateId = str(formData, 'templateId')
  if (!unitId) return { error: 'Choose a unit.', fieldErrors: { unitId: 'Required.' } }
  if (!isInspectionType(type)) {
    return { error: 'Choose an inspection type.', fieldErrors: { type: 'Required.' } }
  }
  if (!templateId) {
    return { error: 'Choose a checklist.', fieldErrors: { templateId: 'Required.' } }
  }

  const unit = await prisma.unit.findUniqueOrThrow({
    where: { id: unitId },
    include: { property: { select: { id: true, legalEntityId: true } } },
  })
  await requirePermission('inspection.write', propertyResource(unit.property))

  const template = await prisma.inspectionTemplate.findUnique({ where: { id: templateId } })
  if (!template) return { error: 'That checklist no longer exists.' }
  const checklist = template.items as unknown as TemplateChecklistItem[]

  // The unit's own current tenancy, if any - an inspection on an occupied
  // unit is naturally tied to the lease it concerns; a vacant-unit
  // inspection (a periodic check between tenancies) has none.
  const lease = await prisma.lease.findFirst({
    where: { unitId, status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
    select: { id: true },
  })

  const inspection = await prisma.$transaction(async (tx) => {
    const created = await tx.inspection.create({
      data: {
        propertyId: unit.propertyId,
        unitId,
        leaseId: lease?.id ?? null,
        type,
        templateId,
        items: {
          create: checklist.map((row, index) => ({
            room: row.room,
            item: row.item,
            order: index,
          })),
        },
      },
    })
    await audit(
      {
        action: 'inspection.created',
        entityType: 'Inspection',
        entityId: created.id,
        propertyId: unit.propertyId,
        after: { type, templateId, templateName: template.name, itemCount: checklist.length },
      },
      tx,
    )
    return created
  })

  revalidatePath('/inspections')
  redirect(`/inspections/${inspection.id}`)
}

/// Records one item's condition + notes - the actual "walk". No audit per
/// item, deliberately: a correction made while still walking is not itself
/// evidence of anything, and REASON_REQUIRED-shaped scrutiny belongs on the
/// finished report, not on every keystroke getting there.
export async function recordItem(
  itemId: string,
  _previous: InspectionFormState,
  formData: FormData,
): Promise<InspectionFormState> {
  const item = await prisma.inspectionItem.findUniqueOrThrow({
    where: { id: itemId },
    include: { inspection: { include: { property: { select: { id: true, legalEntityId: true } } } } },
  })
  await requirePermission('inspection.write', propertyResource(item.inspection.property))

  const decision = canEditItem({ lockedAt: item.inspection.lockedAt })
  if (!decision.allowed) return { error: decision.message }

  const input = { condition: str(formData, 'condition'), notes: str(formData, 'notes') || null }
  const violations = validateItemRecord(input)
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  await prisma.inspectionItem.update({
    where: { id: itemId },
    data: { condition: input.condition as never, notes: input.notes },
  })

  revalidatePath(`/inspections/${item.inspectionId}`)
  return { notice: 'Saved.' }
}

/// Marks the walk performed - every item must already carry a condition
/// (canFinishInspection's own check).
export async function finishInspection(
  inspectionId: string,
  _previous: InspectionFormState,
  _formData: FormData,
): Promise<InspectionFormState> {
  const { inspection, actor } = await inspectionForWrite(inspectionId)

  const decision = canFinishInspection({
    lockedAt: inspection.lockedAt,
    performedAt: inspection.performedAt,
    items: inspection.items,
  })
  if (!decision.allowed) return { error: decision.message }

  await prisma.$transaction(async (tx) => {
    await tx.inspection.update({
      where: { id: inspectionId },
      data: { performedAt: new Date(), performedByStaffId: actor.id },
    })
    await audit(
      {
        action: 'inspection.performed',
        entityType: 'Inspection',
        entityId: inspectionId,
        propertyId: inspection.propertyId,
        after: { itemCount: inspection.items.length },
      },
      tx,
    )
  })

  revalidatePath(`/inspections/${inspectionId}`)
  return { notice: 'Walk finished.' }
}

/// Staff records that a tenant signed - see this file's own header for why
/// this is not a tenant-portal e-sign flow yet.
export async function recordSignature(
  inspectionId: string,
  _previous: InspectionFormState,
  _formData: FormData,
): Promise<InspectionFormState> {
  const { inspection } = await inspectionForWrite(inspectionId)

  const decision = canRecordSignature({
    performedAt: inspection.performedAt,
    tenantSignedAt: inspection.tenantSignedAt,
    lockedAt: inspection.lockedAt,
  })
  if (!decision.allowed) return { error: decision.message }

  await prisma.inspection.update({
    where: { id: inspectionId },
    data: { tenantSignedAt: new Date() },
  })

  revalidatePath(`/inspections/${inspectionId}`)
  return { notice: 'Signature recorded.' }
}

/// Locks the report. Immutable evidence from this point (INSP-01) -
/// `canEditItem` refuses every item write once `lockedAt` is set.
export async function lockInspection(
  inspectionId: string,
  _previous: InspectionFormState,
  _formData: FormData,
): Promise<InspectionFormState> {
  const { inspection } = await inspectionForWrite(inspectionId)

  const decision = canLockInspection({
    performedAt: inspection.performedAt,
    lockedAt: inspection.lockedAt,
  })
  if (!decision.allowed) return { error: decision.message }

  await prisma.$transaction(async (tx) => {
    await tx.inspection.update({
      where: { id: inspectionId },
      data: { lockedAt: new Date() },
    })
    await audit(
      {
        action: 'inspection.locked',
        entityType: 'Inspection',
        entityId: inspectionId,
        propertyId: inspection.propertyId,
        after: { signed: inspection.tenantSignedAt != null },
      },
      tx,
    )
  })

  revalidatePath(`/inspections/${inspectionId}`)
  return { notice: 'Locked. This report can no longer be edited.' }
}
