'use server'

import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { outOfOrderApplicationIds } from './order.ts'

// STAFF writes for ScreeningReport (LEASE-04, R-060) - separate from any
// public/session-less module for the same reason applications/staff-actions.ts
// and prospects/staff-actions.ts already draw the line: audit() pulls in
// Auth.js, which cannot load outside a request, and this file has no
// session-less caller to protect from that in the first place - screening
// data has no applicant-facing page at all.

export interface DecisionFormState {
  error?: string
}

const DECISIONS = ['APPROVED', 'APPROVED_WITH_CONDITIONS', 'DECLINED'] as const
type Decision = (typeof DECISIONS)[number]

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * "Accept/decline always an explicit human action" (LEASE-04) - the one
 * write path to ScreeningReport.decision, and the only place
 * 'screening.decided' is recorded.
 *
 * `notes` (the "individualized-assessment notes field" the backlog names)
 * is required for anything but a plain APPROVED - HUD's guidance on
 * criminal-history screening is why: a decline or a conditional approval is
 * exactly the case that needs a person's stated reasoning attached, not a
 * threshold comparison alone.
 *
 * "Order-of-completed-application enforced or deviation logged": deciding
 * this applicant's household ahead of another, earlier-completed household
 * for the SAME listing that has no decision yet requires `deviationReason`
 * - recorded as 'application_order.deviated', which is REASON_REQUIRED and
 * throws with no reason (packages/core/audit/events.ts).
 */
export async function recordScreeningDecision(
  _previous: DecisionFormState,
  formData: FormData,
): Promise<DecisionFormState> {
  const applicantId = str(formData, 'applicantId')
  const decision = str(formData, 'decision')
  const notes = str(formData, 'notes')
  const deviationReason = str(formData, 'deviationReason')
  if (!applicantId) return { error: 'Nothing was selected to decide.' }
  if (!(DECISIONS as readonly string[]).includes(decision)) {
    return { error: 'Choose approve, approve with conditions, or decline.' }
  }
  if (decision !== 'APPROVED' && !notes) {
    return {
      error:
        'Say why - an individualized-assessment note is required for anything but a plain approval.',
    }
  }

  const applicant = await prisma.applicant.findUniqueOrThrow({
    where: { id: applicantId },
    include: {
      application: { include: { property: true, listing: true } },
      screeningReport: true,
    },
  })
  const { application } = applicant
  const actor = await requirePermission('screening.decide', propertyResource(application.property))

  if (!applicant.screeningReport) return { error: 'No screening report yet for this applicant.' }
  if (applicant.screeningReport.status !== 'COMPLETE') {
    return { error: 'The report has not completed yet.' }
  }
  if (applicant.screeningReport.decision) {
    return { error: 'This applicant already has a recorded decision.' }
  }
  if (!application.completedAt) {
    return { error: "This household's application is not complete yet." }
  }

  const outOfOrder = await outOfOrderApplicationIds(application)
  if (outOfOrder.length > 0 && !deviationReason) {
    return {
      error:
        'Another application for this listing completed earlier and has no decision yet. Say why this one is being decided out of order, or decide that one first.',
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.screeningReport.update({
      where: { applicantId },
      data: {
        decision: decision as Decision,
        decisionNotes: notes || null,
        decidedAt: new Date(),
        decidedByStaffId: actor.id,
      },
    })
    await audit(
      {
        action: 'screening.decided',
        entityType: 'ScreeningReport',
        entityId: applicant.screeningReport!.id,
        propertyId: application.propertyId,
        after: { applicantId, decision, notes: notes || null },
      },
      tx,
    )
    if (outOfOrder.length > 0) {
      await audit(
        {
          action: 'application_order.deviated',
          entityType: 'Application',
          entityId: application.id,
          propertyId: application.propertyId,
          after: { decidedAheadOf: outOfOrder },
          reason: deviationReason,
        },
        tx,
      )
    }
  })

  // Every applicant in the household now decided and none declined -
  // advance the pipeline to APPROVED. A decline stays at SCREENED; there is
  // no separate ProspectStatus for it (that enum's own comment already
  // notes only the first two transitions are automated - see
  // order.ts's identical guard for why this never overwrites a later stage
  // staff already set by hand).
  const allApplicants = await prisma.applicant.findMany({
    where: { applicationId: application.id },
    include: { screeningReport: { select: { decision: true } } },
  })
  const allDecided = allApplicants.every((a) => a.screeningReport?.decision != null)
  const allApproved = allApplicants.every(
    (a) =>
      a.screeningReport?.decision === 'APPROVED' ||
      a.screeningReport?.decision === 'APPROVED_WITH_CONDITIONS',
  )
  if (allDecided && allApproved) {
    await prisma.prospect.updateMany({
      where: { id: application.prospectId, status: 'SCREENED' },
      data: { status: 'APPROVED' },
    })
  }

  revalidatePath(`/prospects/${application.prospectId}`)
  return {}
}
