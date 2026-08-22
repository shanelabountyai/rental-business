'use server'

import { HOLD_DEFINITIONS, holdTypeLabel, isHoldType, liftIsPrivileged } from '@rental/core/holds'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { toCoreHoldType, toDbHoldType } from '@/lib/holds/queries.ts'

// Placing and lifting lease holds (RISK-11, RISK-12; R-084).
//
// Two actions rather than one toggle, because they are not the same act.
// Placing a hold is the safe direction - it stops the automation and costs
// nothing but a missed late fee. Lifting one resumes collection, fees and
// access against a tenancy somebody previously decided needed protecting,
// and for three of the six types that is a legal judgement rather than an
// operational one. A single "set the holds" form would have to gate itself
// on which checkboxes changed in which direction, which is the kind of guard
// that is wrong the first time somebody edits it.

export interface HoldFormState {
  error?: string
  notice?: string
}

export async function placeLeaseHold(
  _previous: HoldFormState,
  formData: FormData,
): Promise<HoldFormState> {
  const leaseId = String(formData.get('leaseId') ?? '')
  const rawType = String(formData.get('type') ?? '')
  const reason = String(formData.get('reason') ?? '').trim()

  if (!leaseId) return { error: 'No tenancy named.' }
  if (!isHoldType(rawType)) return { error: 'Pick a hold type.' }
  if (!reason) return { error: 'A reason is required. It is what the hold is defended from later.' }

  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: { id: true, propertyId: true, property: { select: { id: true, legalEntityId: true } } },
  })
  if (!lease) return { error: 'That tenancy no longer exists.' }

  const actor = await requirePermission('hold.manage', propertyResource(lease.property))

  const type = toDbHoldType(rawType)

  // "At most one active hold of a type" - the invariant the migration
  // deliberately did not express as a partial unique index. Checked here
  // rather than caught as a constraint violation because the answer somebody
  // needs is "it is already on, placed by Dana in March", not a 500.
  const existing = await prisma.leaseHold.findFirst({
    where: { leaseId, type, liftedAt: null },
    select: { id: true, placedAt: true, placedBy: { select: { name: true } } },
  })
  if (existing) {
    return {
      error: `A ${holdTypeLabel(rawType)} hold is already in force, placed by ${existing.placedBy.name}. Lift it before placing another.`,
    }
  }

  const hold = await prisma.leaseHold.create({
    data: {
      leaseId,
      propertyId: lease.propertyId,
      type,
      reason,
      placedByStaffId: actor.id,
    },
  })

  await audit({
    action: 'lease.hold_placed',
    entityType: 'Lease',
    entityId: leaseId,
    propertyId: lease.propertyId,
    reason,
    after: {
      holdId: hold.id,
      type: rawType,
      // SNAPSHOTTED, not recomputed later. The effect table is code, code
      // changes, and "what did this hold actually stop" must not become a
      // question about what today's build thinks it stopped in March.
      effects: HOLD_DEFINITIONS[rawType].effects,
    },
  })

  revalidatePath(`/leases/${leaseId}`)
  return { notice: `${holdTypeLabel(rawType)} hold placed.` }
}

export async function liftLeaseHold(
  _previous: HoldFormState,
  formData: FormData,
): Promise<HoldFormState> {
  const holdId = String(formData.get('holdId') ?? '')
  const liftReason = String(formData.get('liftReason') ?? '').trim()

  if (!holdId) return { error: 'No hold named.' }
  if (!liftReason) {
    return {
      error:
        'A reason is required to lift a hold. This is what answers "on what basis did collection resume".',
    }
  }

  const hold = await prisma.leaseHold.findUnique({
    where: { id: holdId },
    select: {
      id: true,
      leaseId: true,
      propertyId: true,
      type: true,
      liftedAt: true,
      lease: { select: { property: { select: { id: true, legalEntityId: true } } } },
    },
  })
  if (!hold) return { error: 'That hold no longer exists.' }
  if (hold.liftedAt) return { error: 'That hold has already been lifted.' }

  const coreType = toCoreHoldType(hold.type)

  // The permission is chosen BY THE HOLD'S OWN TYPE, from the same table
  // every other guard reads - never by a list of type names written here.
  // A seventh type marked `liftIsPrivileged` is protected by this line on
  // the day it is added, with no edit.
  const actor = await requirePermission(
    liftIsPrivileged(coreType) ? 'hold.lift_protected' : 'hold.manage',
    propertyResource(hold.lease.property),
  )

  await prisma.leaseHold.update({
    where: { id: holdId },
    data: { liftedAt: new Date(), liftedByStaffId: actor.id, liftReason },
  })

  await audit({
    action: 'lease.hold_lifted',
    entityType: 'Lease',
    entityId: hold.leaseId,
    propertyId: hold.propertyId,
    reason: liftReason,
    after: { holdId: hold.id, type: coreType },
  })

  revalidatePath(`/leases/${hold.leaseId}`)
  return { notice: `${holdTypeLabel(coreType)} hold lifted. The automation resumes from now.` }
}
