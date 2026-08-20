'use server'

import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'

// Writes for TurnoverProject (LEASE-12, R-072). Same resource-carrying
// permission check, then transaction-plus-audit shape every other
// lib/*/actions.ts write in this repo takes. `workorder.write` is the right
// gate, not a new `turnover.write` permission - everything on this panel
// (the target date, marking the turn done) is the same authority level as
// closing one of its own punch-list work orders.

export interface TurnoverFormState {
  error?: string
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

async function turnoverForWrite(projectId: string) {
  const project = await prisma.turnoverProject.findUniqueOrThrow({
    where: { id: projectId },
    include: { property: true },
  })
  const actor = await requirePermission('workorder.write', propertyResource(project.property))
  return { project, actor }
}

export async function setTurnoverTargetDate(
  projectId: string,
  _previous: TurnoverFormState,
  formData: FormData,
): Promise<TurnoverFormState> {
  const { project } = await turnoverForWrite(projectId)

  const raw = str(formData, 'targetRentReadyDate')
  const targetRentReadyDate = raw ? new Date(`${raw}T00:00:00.000Z`) : null
  if (raw && Number.isNaN(targetRentReadyDate?.getTime())) {
    return { error: 'Enter a valid date.' }
  }

  await prisma.$transaction(async (tx) => {
    await tx.turnoverProject.update({
      where: { id: projectId },
      data: { targetRentReadyDate },
    })
    await audit(
      {
        action: 'turnover.target_date_set',
        entityType: 'TurnoverProject',
        entityId: projectId,
        propertyId: project.propertyId,
        before: { targetRentReadyDate: project.targetRentReadyDate },
        after: { targetRentReadyDate },
      },
      tx,
    )
  })

  revalidatePath(`/properties/${project.propertyId}/units/${project.unitId}`)
  return { notice: 'Target date saved.' }
}

/**
 * Marks the checklist done. Flips the unit MAKE_READY -> VACANT (guarded -
 * a unit somebody has since taken DOWN for something else is left alone),
 * the same "guarded on the state this action actually means" posture
 * `changeLeaseStatus`'s own occupancy flip takes. Does NOT close or require
 * closing every punch-list work order first - a PM who knows the unit is
 * rentable while one low-priority line item is still open must be able to
 * say so; the items stay open on the unit's record either way.
 */
export async function markTurnoverRentReady(
  projectId: string,
  _previous: TurnoverFormState,
  _formData: FormData,
): Promise<TurnoverFormState> {
  const { project } = await turnoverForWrite(projectId)
  if (project.rentReadyAt) return { notice: 'Already marked rent-ready.' }

  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.turnoverProject.update({
      where: { id: projectId },
      data: { rentReadyAt: now },
    })
    const updated = await tx.unit.updateMany({
      where: { id: project.unitId, status: 'MAKE_READY' },
      data: { status: 'VACANT' },
    })
    await audit(
      {
        action: 'turnover.rent_ready',
        entityType: 'TurnoverProject',
        entityId: projectId,
        propertyId: project.propertyId,
        after: { rentReadyAt: now, unitFlippedToVacant: updated.count > 0 },
      },
      tx,
    )
  })

  revalidatePath(`/properties/${project.propertyId}/units/${project.unitId}`)
  return { notice: 'Turn marked rent-ready.' }
}
