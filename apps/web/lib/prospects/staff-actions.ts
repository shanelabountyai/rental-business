'use server'

import { adverseActionOwed } from '@rental/core/screening'
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
  /// Set when moving to APPROVED/SIGNED and an adverse-action notice is
  /// still owed on this prospect's application (R-061, LEASE-05) - the form
  /// re-renders with the warning and an override field, same shape
  /// workorders/scheduling.ts's ScheduleResult already gives its own
  /// warn-and-override.
  needsOverride?: { applicantNames: string[] }
  /// React 19 resets uncontrolled fields once a form action completes - see
  /// ScheduleResult's identical field for why this is echoed back rather
  /// than lost on the warn-and-override round trip.
  values?: { status: string }
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

const PIPELINE_STAGES = ['SHOWING', 'APPLIED', 'SCREENED', 'APPROVED', 'SIGNED'] as const
/// Stages "closing the application" (LEASE-05) - the point past which an
/// unresolved adverse-action obligation must not go unnoticed.
const CLOSING_STAGES = new Set(['APPROVED', 'SIGNED'])

/**
 * A staff member moves a prospect forward by hand.
 *
 * No transition matrix (packages/core/units/validate.ts's own precedent for
 * UnitStatus: "status is free-form for staff") - nothing downstream reads
 * this field to drive a real invariant yet, unlike Lease's own status
 * machine, so there is no automated consequence a strict ordering would be
 * protecting. THE ONE EXCEPTION is R-061's adverse-action block: moving to
 * APPROVED or SIGNED while any applicant on the live Application still owes
 * an unsent, un-overridden FCRA notice warns and requires a reason, the
 * same shape scheduleEntry's own warn-and-override already gives entry
 * notices.
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
  const actor = await requirePermission('lease.write', propertyResource(prospect.property))

  const to = str(formData, 'status')
  const overrideReason = str(formData, 'overrideReason') || null
  if (!(PIPELINE_STAGES as readonly string[]).includes(to)) {
    return { error: 'Choose a stage.' }
  }
  const values = { status: to }

  let owingApplicants: { id: string; name: string; screeningReportId: string }[] = []
  if (CLOSING_STAGES.has(to)) {
    const application = await prisma.application.findFirst({
      where: { prospectId },
      orderBy: { createdAt: 'desc' },
      include: {
        applicants: {
          include: {
            screeningReport: {
              select: {
                id: true,
                decision: true,
                adverseActionOverriddenAt: true,
                adverseActionNotice: { select: { servedAt: true } },
              },
            },
          },
        },
      },
    })
    owingApplicants = (application?.applicants ?? [])
      .filter((a) =>
        adverseActionOwed({
          decision: a.screeningReport?.decision ?? null,
          noticeSentAt: a.screeningReport?.adverseActionNotice?.servedAt ?? null,
          overriddenAt: a.screeningReport?.adverseActionOverriddenAt ?? null,
        }),
      )
      .map((a) => ({ id: a.id, name: `${a.firstName} ${a.lastName}`, screeningReportId: a.screeningReport!.id }))

    if (owingApplicants.length > 0 && !overrideReason) {
      return {
        error:
          'An adverse-action notice has not been sent for every applicant. Say why this is moving ahead anyway, or send the notice first.',
        needsOverride: { applicantNames: owingApplicants.map((a) => a.name) },
        values,
      }
    }
  }

  const now = new Date()
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
    for (const applicant of owingApplicants) {
      await tx.screeningReport.update({
        where: { id: applicant.screeningReportId },
        data: {
          adverseActionOverrideReason: overrideReason,
          adverseActionOverriddenAt: now,
          adverseActionOverriddenByStaffId: actor.id,
        },
      })
      await audit(
        {
          action: 'adverse_action.overridden',
          entityType: 'ScreeningReport',
          entityId: applicant.screeningReportId,
          propertyId: prospect.propertyId,
          after: { applicantId: applicant.id, movedTo: to },
          reason: overrideReason!,
        },
        tx,
      )
    }
  })

  revalidatePath(`/prospects/${prospectId}`)
  revalidatePath('/prospects')
  return {}
}
