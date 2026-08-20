'use server'

import { canEditItem, canFinishInspection, canRecordSignature } from '@rental/core/inspections'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { writeItemCondition, writeItemPhoto } from '@/lib/inspections/item-writes.ts'
import { requireTenantWithScope } from './guard.ts'

// The tenant's own e-sign (INSP-01, R-068 phase 2). Lives on the PORTAL
// side, with the portal's own guard - the actor is a tenant, and
// `requirePermission()` reads a staff session (verify-actions.ts's own
// header states the identical reasoning for the same wall).
//
// SIGNING AND LOCKING HAPPEN TOGETHER, deliberately unlike the staff path
// (`recordSignature`/`lockInspection` in lib/inspections/actions.ts, kept
// as two separate steps so a staff member reviewing evidence gets a
// checkpoint before finalizing). A tenant signing from the portal has
// already done their own review by definition - the form IS the review -
// so there is no second staff-side checkpoint to wait for; the report
// becomes immutable evidence in the same transaction as the signature.

export interface InspectionSignFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

export async function signInspectionAsTenant(
  inspectionId: string,
  _previous: InspectionSignFormState,
  formData: FormData,
): Promise<InspectionSignFormState> {
  const { scope } = await requireTenantWithScope()

  const inspection = await prisma.inspection.findUniqueOrThrow({ where: { id: inspectionId } })
  if (!inspection.leaseId || !scope.leaseIds.includes(inspection.leaseId)) {
    // "Not yours" reads the same as "does not exist" (DOC-03's own rule) -
    // no signal to a tenant probing an id that it belongs to someone else.
    return { error: 'That report could not be found.' }
  }

  const agreed = formData.get('agree') === 'on'
  if (!agreed) {
    return {
      error: 'Confirm the report is accurate before signing.',
      fieldErrors: { agree: 'Required.' },
    }
  }

  const decision = canRecordSignature({
    performedAt: inspection.performedAt,
    tenantSignedAt: inspection.tenantSignedAt,
    lockedAt: inspection.lockedAt,
  })
  if (!decision.allowed) return { error: decision.message }

  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.inspection.update({
      where: { id: inspectionId },
      data: { tenantSignedAt: now, lockedAt: now },
    })
    await audit(
      {
        action: 'inspection.signed',
        entityType: 'Inspection',
        entityId: inspectionId,
        propertyId: inspection.propertyId,
        after: { recordedBy: 'TENANT' },
      },
      tx,
    )
    await audit(
      {
        action: 'inspection.locked',
        entityType: 'Inspection',
        entityId: inspectionId,
        propertyId: inspection.propertyId,
        after: { signed: true },
      },
      tx,
    )
  })

  revalidatePath(`/portal/papers/inspections/${inspectionId}`)
  revalidatePath('/portal/papers')
  return { notice: 'Signed. This report is now final.' }
}

// The tenant's own self-guided walk (INSP-05, R-074) - three actions
// mirroring the staff walk in lib/inspections/actions.ts (`recordItem`,
// `recordItemPhoto`, `finishInspection`) exactly, gated on
// `Inspection.selfGuided` rather than `inspection.write`: a tenant may only
// write items on a MOVE_IN inspection staff explicitly created for them to
// complete, never a traditional staff-performed one just because it happens
// to still be unperformed. Signing afterward reuses `signInspectionAsTenant`
// above unchanged - once `finishInspectionAsTenant` sets `performedAt`, the
// existing sign form on the tenant's own page is already the right next
// step, with nothing here needing to duplicate it.

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

async function selfGuidedItemForWrite(itemId: string, scope: { leaseIds: readonly string[] }) {
  const item = await prisma.inspectionItem.findUniqueOrThrow({
    where: { id: itemId },
    include: {
      inspection: {
        select: { id: true, selfGuided: true, leaseId: true, propertyId: true, lockedAt: true },
      },
    },
  })
  // "Not yours" and "not self-guided" both read as "does not exist" (DOC-03's
  // own rule) - neither is a signal worth giving back to a tenant probing an
  // id.
  if (
    !item.inspection.selfGuided ||
    !item.inspection.leaseId ||
    !scope.leaseIds.includes(item.inspection.leaseId)
  ) {
    return null
  }
  return item
}

export async function recordItemAsTenant(
  itemId: string,
  _previous: InspectionSignFormState,
  formData: FormData,
): Promise<InspectionSignFormState> {
  const { scope } = await requireTenantWithScope()
  const item = await selfGuidedItemForWrite(itemId, scope)
  if (!item) return { error: 'That report could not be found.' }

  const decision = canEditItem({ lockedAt: item.inspection.lockedAt })
  if (!decision.allowed) return { error: decision.message }

  const input = { condition: str(formData, 'condition'), notes: str(formData, 'notes') || null }
  const violation = await writeItemCondition(itemId, input)
  if (violation) return violation

  revalidatePath(`/portal/papers/inspections/${item.inspection.id}`)
  return { notice: 'Saved.' }
}

export async function recordItemPhotoAsTenant(
  itemId: string,
  _previous: InspectionSignFormState,
  formData: FormData,
): Promise<InspectionSignFormState> {
  const { scope } = await requireTenantWithScope()
  const item = await selfGuidedItemForWrite(itemId, scope)
  if (!item) return { error: 'That report could not be found.' }

  const decision = canEditItem({ lockedAt: item.inspection.lockedAt })
  if (!decision.allowed) return { error: decision.message }

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Choose a photo.', fieldErrors: { file: 'Required.' } }
  }

  await writeItemPhoto(
    { id: itemId, propertyId: item.inspection.propertyId, leaseId: item.inspection.leaseId },
    file,
  )

  revalidatePath(`/portal/papers/inspections/${item.inspection.id}`)
  return { notice: 'Photo added.' }
}

export async function finishInspectionAsTenant(
  inspectionId: string,
  _previous: InspectionSignFormState,
  _formData: FormData,
): Promise<InspectionSignFormState> {
  const { scope } = await requireTenantWithScope()
  const inspection = await prisma.inspection.findUniqueOrThrow({
    where: { id: inspectionId },
    include: { items: { select: { condition: true } } },
  })
  if (!inspection.selfGuided || !inspection.leaseId || !scope.leaseIds.includes(inspection.leaseId)) {
    return { error: 'That report could not be found.' }
  }

  const decision = canFinishInspection({
    lockedAt: inspection.lockedAt,
    performedAt: inspection.performedAt,
    items: inspection.items,
  })
  if (!decision.allowed) return { error: decision.message }

  // `performedByStaffId` stays null - that absence, alongside `selfGuided`,
  // IS the record that the tenant walked this one themselves.
  await prisma.$transaction(async (tx) => {
    await tx.inspection.update({ where: { id: inspectionId }, data: { performedAt: new Date() } })
    await audit(
      {
        action: 'inspection.performed',
        entityType: 'Inspection',
        entityId: inspectionId,
        propertyId: inspection.propertyId,
        after: { itemCount: inspection.items.length, recordedBy: 'TENANT' },
      },
      tx,
    )
  })

  revalidatePath(`/portal/papers/inspections/${inspectionId}`)
  return { notice: 'Walk finished. Review it below, then sign.' }
}
