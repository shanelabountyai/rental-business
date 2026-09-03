'use server'

import {
  canEditItem,
  canFinishInspection,
  canLockInspection,
  canRecordSignature,
  inspectionRequiresEntryNotice,
  isInspectionType,
  type TemplateChecklistItem,
} from '@rental/core/inspections'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { authUrl } from '@/lib/auth/delivery.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { writeItemCondition, writeItemPhoto } from '@/lib/inspections/item-writes.ts'
import { itemsFromMoveIn } from '@/lib/inspections/move-out-copy.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { draftPunchListFromInspection } from '@/lib/turnover/punch-list.ts'

/// MOVE_OUT and PRE_MOVE_OUT both compare against move-in (INSP-02) - a
/// preliminary walkthrough and the real one read the same baseline.
const MOVE_OUT_FAMILY = new Set(['MOVE_OUT', 'PRE_MOVE_OUT'])

// Writes for Inspection (INSP-01, R-068). Same shape every other
// lib/*/actions.ts in this repo takes: a resource-carrying permission check
// first, then a transaction pairing the write with its audit entry where
// one is warranted.
//
// PHASE 2 OF THIS ITEM adds photo capture (this file) and a
// tenant-portal e-sign (apps/web/lib/portal/inspection-actions.ts) and an
// auto-finalize job (apps/web/lib/inspections/auto-finalize-job.ts) on top
// of phase 1's engine. `recordSignature` below is still the STAFF path -
// "a tenant signed in person, on the inspector's own phone" - now alongside
// the tenant's own portal path, not replaced by it.

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
      property: { select: { id: true, legalEntityId: true, addressLine1: true, timezone: true } },
      unit: { select: { name: true } },
      // For the entry-notice gate on finishing the walk (R-157): whether
      // anybody is living in the unit this inspection entered.
      lease: { select: { status: true } },
      items: { select: { id: true, room: true, item: true, condition: true, notes: true } },
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
  // INSP-05 (R-074): only meaningful for MOVE_IN - ignored for every other
  // type rather than rejected, so a stray checked box from the client never
  // turns into a form error for a type where it does nothing.
  const selfGuided = type === 'MOVE_IN' && formData.get('selfGuided') === 'on'
  if (!unitId) return { error: 'Choose a unit.', fieldErrors: { unitId: 'Required.' } }
  if (!isInspectionType(type)) {
    return { error: 'Choose an inspection type.', fieldErrors: { type: 'Required.' } }
  }

  const unit = await prisma.unit.findUniqueOrThrow({
    where: { id: unitId },
    include: { property: { select: { id: true, legalEntityId: true, addressLine1: true } } },
  })
  await requirePermission('inspection.write', propertyResource(unit.property))

  // The unit's own tenancy this inspection concerns. NOT limited to
  // ACTIVE/MONTH_TO_MONTH: by the time staff runs the real move-out walk the
  // lease has often already been marked ENDED, and a move-out inspection
  // that cannot find "its own" lease can never be paired against that
  // lease's move-in (INSP-02) or show up on the tenant's own portal. The
  // most recently STARTED tenancy on the unit is the right one whatever its
  // current status - there is at most one lease actually running or just
  // finished on a single-family unit at a time.
  const lease = await prisma.lease.findFirst({
    where: { unitId, status: { in: ['ACTIVE', 'MONTH_TO_MONTH', 'ENDED', 'TERMINATED'] } },
    select: { id: true },
    orderBy: { startsOn: 'desc' },
  })

  // MOVE_OUT/PRE_MOVE_OUT: prefer copying the lease's own move-in checklist
  // over whatever template was picked, so every item is pre-linked to its
  // move-in counterpart (moveInItemId) and the side-by-side comparison has
  // something to show without staff re-typing the room/item list. Falls
  // through to the ordinary template path when there is nothing to copy.
  const moveInCopy = MOVE_OUT_FAMILY.has(type) ? await itemsFromMoveIn(prisma, lease?.id ?? null) : null

  let template: { id: string; name: string; items: unknown } | null = null
  let checklist: TemplateChecklistItem[] = []
  if (!moveInCopy) {
    if (!templateId) {
      return { error: 'Choose a checklist.', fieldErrors: { templateId: 'Required.' } }
    }
    template = await prisma.inspectionTemplate.findUnique({ where: { id: templateId } })
    if (!template) return { error: 'That checklist no longer exists.' }
    checklist = template.items as unknown as TemplateChecklistItem[]
  }

  const inspection = await prisma.$transaction(async (tx) => {
    const created = await tx.inspection.create({
      data: {
        propertyId: unit.propertyId,
        unitId,
        leaseId: lease?.id ?? null,
        type,
        selfGuided,
        templateId: moveInCopy ? null : templateId,
        items: {
          create: moveInCopy
            ? moveInCopy.items
            : checklist.map((row, index) => ({ room: row.room, item: row.item, order: index })),
        },
      },
    })
    await audit(
      {
        action: 'inspection.created',
        entityType: 'Inspection',
        entityId: created.id,
        propertyId: unit.propertyId,
        after: moveInCopy
          ? {
              type,
              selfGuided,
              copiedFromInspectionId: moveInCopy.sourceInspectionId,
              itemCount: moveInCopy.items.length,
            }
          : { type, selfGuided, templateId, templateName: template!.name, itemCount: checklist.length },
      },
      tx,
    )
    return created
  })

  // Outside the transaction, best-effort, same posture finishInspection's
  // own notify call already takes: a self-guided report is useless to a
  // tenant who never learns it exists.
  if (selfGuided && lease) {
    try {
      const primaryTenant = await prisma.leaseTenant.findFirst({
        where: { leaseId: lease.id, isPrimary: true },
        include: { tenant: { select: { id: true, firstName: true, email: true, phone: true } } },
      })
      if (primaryTenant) {
        const outcomes = await notify({
          category: 'inspection_signature',
          templateKey: 'inspection.move_in_ready',
          recipient: {
            type: 'TENANT',
            id: primaryTenant.tenant.id,
            email: primaryTenant.tenant.email,
            phone: primaryTenant.tenant.phone,
          },
          context: {
            tenantName: primaryTenant.tenant.firstName,
            addressLine1: unit.property.addressLine1,
            unitName: unit.name,
            url: authUrl(`/portal/papers/inspections/${inspection.id}`),
          },
          propertyId: unit.propertyId,
          idempotencyKey: `inspection-move-in-ready:${inspection.id}`,
        })
        await dispatchPendingNotifications(new Date(), 100, {
          deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
        })
      }
    } catch (error) {
      console.error(`[inspections] failed to notify tenant for self-guided ${inspection.id}`, error)
    }
  }

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
  const violation = await writeItemCondition(itemId, input)
  if (violation) return violation

  revalidatePath(`/inspections/${item.inspectionId}`)
  return { notice: 'Saved.' }
}

/**
 * Attaches a photo to one checklist item (INSP-01: "photos (timestamped,
 * geotagged)"). Multiple photos per item are allowed - each call adds a
 * new `Document` row rather than replacing one, the same "a new row every
 * time" posture `recordRenterInsurance` already takes for the identical
 * reason: a photo already taken is evidence, not a draft to overwrite.
 *
 * Gated by `canEditItem`, the same guard `recordItem` uses - a photo is
 * part of editing the item's evidence, and must be refused once locked
 * exactly like a condition/notes change would be.
 */
export async function recordItemPhoto(
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

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Choose a photo.', fieldErrors: { file: 'Required.' } }
  }

  await writeItemPhoto(
    { id: itemId, propertyId: item.inspection.propertyId, leaseId: item.inspection.leaseId },
    file,
  )

  revalidatePath(`/inspections/${item.inspectionId}`)
  return { notice: 'Photo added.' }
}

/// Marks the walk performed - every item must already carry a condition
/// (canFinishInspection's own check).
export interface FinishWalkResult extends InspectionFormState {
  /// R-157: the walk entered an occupied unit and no entry notice was
  /// served for it. The form re-renders with a warning and a required
  /// reason field - warn-and-override (R-027's posture), never a hard
  /// block: the walk already happened, and refusing to record it would
  /// just push staff to stop recording walks at all.
  needsEntryOverride?: boolean
}

export async function finishInspection(
  inspectionId: string,
  _previous: FinishWalkResult,
  formData: FormData,
): Promise<FinishWalkResult> {
  const { inspection, actor } = await inspectionForWrite(inspectionId)

  const decision = canFinishInspection({
    lockedAt: inspection.lockedAt,
    performedAt: inspection.performedAt,
    items: inspection.items,
  })
  if (!decision.allowed) return { error: decision.message }

  // THE ENTRY-NOTICE GATE (R-157). A walk of an occupied interior cannot be
  // marked performed unless entry rested on something: a served notice
  // (scheduleInspectionEntry), an override logged at scheduling, or an
  // override reason stated right here. Without it, the auto-scheduled
  // annual walk was an undocumented entry into somebody's home - exposure
  // that taints the very photos a deposit case rests on.
  const entryRequired = inspectionRequiresEntryNotice(
    inspection.type,
    inspection.lease?.status ?? null,
  )
  const entryUnaccounted =
    entryRequired && inspection.entryNoticeId == null && inspection.entryOverriddenAt == null
  const entryOverrideReason = str(formData, 'entryOverrideReason')
  if (entryUnaccounted && !entryOverrideReason) {
    return {
      error:
        'No entry notice was served for this walk. State why entry was made without one - it is recorded.',
      needsEntryOverride: true,
    }
  }

  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.inspection.update({
      where: { id: inspectionId },
      data: {
        performedAt: now,
        performedByStaffId: actor.id,
        ...(entryUnaccounted
          ? { entryOverrideReason, entryOverriddenAt: now }
          : {}),
      },
    })
    if (entryUnaccounted) {
      await audit(
        {
          action: 'entry_notice.overridden',
          entityType: 'Inspection',
          entityId: inspectionId,
          propertyId: inspection.propertyId,
          after: { performedWithoutNotice: true, type: inspection.type },
          // entry_notice.overridden is in REASON_REQUIRED - recordAudit()
          // itself refuses to write it without the reason.
          reasonCode: 'other',
          reason: entryOverrideReason,
        },
        tx,
      )
    }
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

  // Outside the transaction - a notification send must not hold row locks
  // (R-016's rule, the same posture every other notify() call in this
  // codebase takes). Best-effort: a failed send must not undo the walk
  // just finished, the same reasoning scheduleEntry's own identical
  // try/catch gives its tenant notification.
  if (inspection.leaseId) {
    try {
      const primaryTenant = await prisma.leaseTenant.findFirst({
        where: { leaseId: inspection.leaseId, isPrimary: true },
        include: { tenant: { select: { id: true, firstName: true, email: true, phone: true } } },
      })
      if (primaryTenant) {
        const outcomes = await notify({
          category: 'inspection_signature',
          templateKey: 'inspection.signature_needed',
          recipient: {
            type: 'TENANT',
            id: primaryTenant.tenant.id,
            email: primaryTenant.tenant.email,
            phone: primaryTenant.tenant.phone,
          },
          context: {
            tenantName: primaryTenant.tenant.firstName,
            addressLine1: inspection.property.addressLine1,
            unitName: inspection.unit.name,
            url: authUrl(`/portal/papers/inspections/${inspectionId}`),
          },
          propertyId: inspection.propertyId,
          idempotencyKey: `inspection-signature-needed:${inspectionId}`,
        })
        await dispatchPendingNotifications(new Date(), 100, {
          deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
        })
      }
    } catch (error) {
      console.error(`[inspections] failed to notify tenant for ${inspectionId}`, error)
    }
  }

  revalidatePath(`/inspections/${inspectionId}`)
  return { notice: 'Walk finished.' }
}

/// Staff records that a tenant signed in person, on the inspector's own
/// phone - the STAFF doorway. `apps/web/lib/portal/inspection-actions.ts`'s
/// `signInspectionAsTenant` is the tenant's own doorway, from the portal;
/// both write the identical `inspection.signed` audit action, distinguished
/// by `actorType` (STAFF here, TENANT there) rather than two different
/// actions for the same fact.
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

  await prisma.$transaction(async (tx) => {
    await tx.inspection.update({
      where: { id: inspectionId },
      data: { tenantSignedAt: new Date() },
    })
    await audit(
      {
        action: 'inspection.signed',
        entityType: 'Inspection',
        entityId: inspectionId,
        propertyId: inspection.propertyId,
        after: { recordedBy: 'STAFF' },
      },
      tx,
    )
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
  const { inspection, actor } = await inspectionForWrite(inspectionId)

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
    // INSP-06 (R-072): the same lock that makes this report immutable
    // evidence also drafts the turnover's punch list from it.
    await draftPunchListFromInspection(tx, inspection, inspection.items, {
      type: 'STAFF',
      staffUserId: actor.id,
    })
  })

  revalidatePath(`/inspections/${inspectionId}`)
  return { notice: 'Locked. This report can no longer be edited.' }
}
