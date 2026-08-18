'use server'

import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'

// STAFF writes for Prospect (LEASE-07, R-058) - separate from actions.ts,
// which has to stay import-clean of lib/audit/index.ts (and therefore of
// Auth.js) so it can be tested with no session at all. See that file's own
// header for the wall this split works around.

export interface StageFormState {
  error?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

const PIPELINE_STAGES = ['SHOWING', 'APPLIED', 'SCREENED', 'APPROVED', 'SIGNED'] as const

/**
 * A staff member moves a prospect forward by hand.
 *
 * No transition matrix (packages/core/units/validate.ts's own precedent for
 * UnitStatus: "status is free-form for staff") - nothing downstream reads
 * this field to drive a real invariant yet, unlike Lease's own status
 * machine, so there is no automated consequence a strict ordering would be
 * protecting.
 */
export async function advanceProspectStage(
  prospectId: string,
  _previous: StageFormState,
  formData: FormData,
): Promise<StageFormState> {
  const prospect = await prisma.prospect.findUnique({
    where: { id: prospectId },
    include: { property: true },
  })
  if (!prospect) return { error: 'That prospect no longer exists.' }
  await requirePermission('lease.write', propertyResource(prospect.property))

  const to = str(formData, 'status')
  if (!(PIPELINE_STAGES as readonly string[]).includes(to)) {
    return { error: 'Choose a stage.' }
  }

  await prisma.$transaction(async (tx) => {
    await tx.prospect.update({ where: { id: prospectId }, data: { status: to as never } })
    await audit(
      {
        action: 'prospect.stage_changed',
        entityType: 'Prospect',
        entityId: prospectId,
        propertyId: prospect.propertyId,
        before: { status: prospect.status },
        after: { status: to },
      },
      tx,
    )
  })

  revalidatePath(`/prospects/${prospectId}`)
  revalidatePath('/prospects')
  return {}
}
