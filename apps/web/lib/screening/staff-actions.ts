'use server'

import { adverseActionNoticeText, adverseActionOwed, evaluateCriteria } from '@rental/core/screening'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
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
 *
 * "Generated on any decline or approve-with-conditions" (R-061, LEASE-05):
 * a DECLINED or APPROVED_WITH_CONDITIONS decision writes an FCRA
 * adverse-action Notice in the SAME transaction as the decision, and - when
 * the applicant has an email on file - serves it immediately (EMAIL) the
 * same way an entry notice auto-serves to the portal (scheduling.ts's own
 * precedent). No email on file means no auto-serve; the compliance block
 * below then requires a staff member to record service some other way, or
 * override it with a reason.
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

  const owesAdverseAction = decision === 'DECLINED' || decision === 'APPROVED_WITH_CONDITIONS'
  const addressOfRecord = [
    applicant.currentAddressLine1,
    [applicant.currentCity, applicant.currentState, applicant.currentPostalCode]
      .filter(Boolean)
      .join(', '),
  ]
    .filter(Boolean)
    .join('\n')
  const canAutoServe = owesAdverseAction && Boolean(applicant.email) && Boolean(addressOfRecord)

  const { noticeId, autoServed, bodyText } = await prisma.$transaction(async (tx) => {
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

    if (!owesAdverseAction) return { noticeId: null, autoServed: false, bodyText: null }

    const criteria = await tx.screeningCriteria.findUniqueOrThrow({
      where: { version: applicant.screeningReport!.criteriaVersion },
    })
    const factors = evaluateCriteria(criteria, {
      monthlyIncomeCents: applicant.monthlyIncomeCents,
      rentCents: application.listing.rentCents,
      creditScore: applicant.screeningReport!.creditScore,
      evictionRecordFound: applicant.screeningReport!.evictionRecordFound,
      criminalRecordFound: applicant.screeningReport!.criminalRecordFound,
    })
      .filter((c) => c.result === 'FAILS')
      .map((c) => c.detail)

    const bodyText = adverseActionNoticeText({
      applicantName: `${applicant.firstName} ${applicant.lastName}`,
      addressLine1: application.property.addressLine1,
      decision: decision as 'APPROVED_WITH_CONDITIONS' | 'DECLINED',
      agencyContact: applicant.screeningReport!.agencyContact ?? '(agency not on file)',
      factors,
      decisionNotes: notes || null,
    })

    const now = new Date()
    const notice = await tx.notice.create({
      data: {
        propertyId: application.propertyId,
        applicantId,
        type: 'ADVERSE_ACTION',
        addressOfRecord: addressOfRecord || '(no address on file)',
        bodyText,
        ...(canAutoServe
          ? { serviceMethod: 'EMAIL', servedAt: now, servedByStaffId: actor.id }
          : {}),
      },
    })

    if (canAutoServe) {
      await tx.noticeDelivery.create({
        data: { noticeId: notice.id, method: 'EMAIL', servedAt: now, servedByStaffId: actor.id },
      })
      await audit(
        {
          action: 'notice.served',
          entityType: 'Notice',
          entityId: notice.id,
          propertyId: application.propertyId,
          after: { type: 'ADVERSE_ACTION', serviceMethod: 'EMAIL' },
        },
        tx,
      )
    }

    await tx.screeningReport.update({
      where: { applicantId },
      data: { adverseActionNoticeId: notice.id },
    })

    return { noticeId: notice.id, autoServed: canAutoServe, bodyText }
  })

  // The email ITSELF, outside the transaction (R-016's rule, scheduling.ts's
  // own precedent: notify decides and records, dispatch sends, neither
  // belongs inside a transaction holding row locks).
  if (autoServed && noticeId) {
    try {
      const outcomes = await notify({
        category: 'prospect_application',
        templateKey: 'application.adverse_action',
        recipient: { type: 'APPLICANT', id: applicant.id, email: applicant.email, phone: applicant.phone },
        context: {
          firstName: applicant.firstName,
          addressLine1: application.property.addressLine1,
          noticeText: bodyText!,
        },
        propertyId: application.propertyId,
        idempotencyKey: `adverse-action:${noticeId}`,
      })
      await dispatchPendingNotifications(new Date(), 50, {
        deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
      })
    } catch (error) {
      console.error(`[screening] failed to email adverse action notice ${noticeId}`, error)
    }
  }

  // Every applicant in the household now decided, none declined, and no
  // adverse action still owed - advance the pipeline to APPROVED. A decline
  // stays at SCREENED; there is no separate ProspectStatus for it (that
  // enum's own comment already notes only the first two transitions are
  // automated - see order.ts's identical guard for why this never
  // overwrites a later stage staff already set by hand). An
  // APPROVED_WITH_CONDITIONS applicant with an unsent, un-overridden notice
  // holds the WHOLE household at SCREENED until that is resolved - this is
  // "blocks closing the application" (LEASE-05).
  const allApplicants = await prisma.applicant.findMany({
    where: { applicationId: application.id },
    include: {
      screeningReport: {
        select: {
          decision: true,
          adverseActionOverriddenAt: true,
          adverseActionNotice: { select: { servedAt: true } },
        },
      },
    },
  })
  const allDecided = allApplicants.every((a) => a.screeningReport?.decision != null)
  const allApproved = allApplicants.every(
    (a) =>
      a.screeningReport?.decision === 'APPROVED' ||
      a.screeningReport?.decision === 'APPROVED_WITH_CONDITIONS',
  )
  const noneOwed = allApplicants.every(
    (a) =>
      !adverseActionOwed({
        decision: a.screeningReport?.decision ?? null,
        noticeSentAt: a.screeningReport?.adverseActionNotice?.servedAt ?? null,
        overriddenAt: a.screeningReport?.adverseActionOverriddenAt ?? null,
      }),
  )
  if (allDecided && allApproved && noneOwed) {
    await prisma.prospect.updateMany({
      where: { id: application.prospectId, status: 'SCREENED' },
      data: { status: 'APPROVED' },
    })
  }

  revalidatePath(`/prospects/${application.prospectId}`)
  return {}
}
