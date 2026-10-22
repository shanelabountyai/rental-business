import 'server-only'

import type { Actor } from '@rental/core/rbac'
import { adverseActionOwed } from '@rental/core/screening'
import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { openLeaseDraft } from '@/lib/applications/lease-draft.ts'
import { reachOf, type Reach } from '@/lib/notifications/reach.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { propertyOwner } from '@/lib/staff/property-owner.ts'
import { createTask } from '@/lib/tasks/create.ts'

/**
 * Is the household approved now, and if it just became so, open its lease
 * draft and tell everyone (R-270, PRD 08 C4/C5, D-334, D-335).
 *
 * Every applicant decided, none declined, and no adverse action still owed -
 * advance the pipeline to APPROVED. A decline stays at SCREENED; there is no
 * separate ProspectStatus for it (order.ts's identical guard is why this
 * never overwrites a later stage staff already set by hand). An
 * APPROVED_WITH_CONDITIONS applicant with an unsent, un-overridden notice
 * holds the WHOLE household at SCREENED - "blocks closing the application"
 * (LEASE-05).
 *
 * THREE CALLERS, because the last blocker can clear three ways: the last
 * decision (`recordScreeningDecision`), the owed notice served afterwards
 * (`recordNoticeService`), or the notice overridden on the pipeline form
 * (`advanceProspectStage`). R-270 wired only the first, so a household held by
 * an unserved notice never got its draft or its approval (D-335).
 * `alreadyAdvanced` is the override caller: that form has just written
 * APPROVED itself, so the SCREENED -> APPROVED guard cannot be what proves the
 * transition happened. A plain hand move with nothing owed calls nothing.
 */
export async function settleHousehold(
  applicationId: string,
  actor: Actor,
  options: { alreadyAdvanced?: boolean } = {},
): Promise<{ allDecided: boolean }> {
  const application = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    include: {
      property: { select: { id: true, legalEntityId: true, addressLine1: true, timezone: true } },
      applicants: {
        include: {
          screeningReport: {
            select: {
              decision: true,
              adverseActionOverriddenAt: true,
              adverseActionNotice: { select: { servedAt: true } },
            },
          },
        },
      },
    },
  })
  const all = application.applicants
  const allDecided = all.every((a) => a.screeningReport?.decision != null)
  const allApproved = all.every(
    (a) =>
      a.screeningReport?.decision === 'APPROVED' ||
      a.screeningReport?.decision === 'APPROVED_WITH_CONDITIONS',
  )
  const noneOwed = all.every(
    (a) =>
      !adverseActionOwed({
        decision: a.screeningReport?.decision ?? null,
        noticeSentAt: a.screeningReport?.adverseActionNotice?.servedAt ?? null,
        overriddenAt: a.screeningReport?.adverseActionOverriddenAt ?? null,
      }),
  )
  if (!(allDecided && allApproved && noneOwed)) return { allDecided }

  const advanced = options.alreadyAdvanced
    ? true
    : (
        await prisma.prospect.updateMany({
          where: { id: application.prospectId, status: 'SCREENED' },
          data: { status: 'APPROVED' },
        })
      ).count > 0
  // Only on the transition itself. The draft is unique per application and
  // every message is keyed per applicant, so a second caller is harmless too.
  // Outside any transaction: whatever cleared the blocker stands whatever
  // happens here.
  if (advanced) {
    const draft = await openLeaseDraft(applicationId, actor).catch((error) => {
      console.error(`[screening] lease draft failed for application ${applicationId}`, error)
      return { skipped: 'it failed - see the server log' }
    })
    // The approval text says the lease is coming, so a skipped draft is work
    // somebody owes, not a log line (D-336): a Task for the owner, with why.
    // The prospect page also warns while no draft exists.
    if ('skipped' in draft) {
      console.warn(`[screening] no lease draft for application ${applicationId}: ${draft.skipped}`)
      const owner = await propertyOwner(application.property)
      await createTask(prisma, {
        propertyId: application.propertyId,
        type: 'application.lease_draft',
        subjectType: 'Application',
        subjectId: applicationId,
        businessDate: businessDate(new Date(), application.property.timezone),
        priority: 'ROUTINE',
        assigneeStaffId: owner?.id ?? null,
        title: `Prepare the lease by hand for ${application.property.addressLine1}: the household is approved and was told a lease is coming, but no draft opened because ${draft.skipped}`,
      }).catch((error) => {
        console.error(`[screening] lease-draft Task failed for application ${applicationId}`, error)
      })
    }
    for (const member of all) {
      await tellApplicant(member, application, 'application.approved', `application-approved:${member.id}`)
    }
  }
  return { allDecided }
}

/**
 * One applicant message (R-270), sent now rather than at the next cron tick,
 * and what happened to it. A co-applicant is never texted - nobody consented
 * for them (LEGAL-03, `smsConsentVerdict`) - so one with no email gets
 * nothing, and the reach says so instead of claiming a send. Never throws:
 * the decision or request it follows is already recorded.
 */
export async function tellApplicant(
  applicant: { id: string; firstName: string; email: string | null; phone: string | null },
  application: { propertyId: string; property: { addressLine1: string } },
  templateKey: string,
  idempotencyKey: string,
  extra: Record<string, string> = {},
): Promise<Reach> {
  try {
    const outcomes = await notify({
      category: 'prospect_application',
      templateKey,
      recipient: { type: 'APPLICANT', id: applicant.id, email: applicant.email, phone: applicant.phone },
      context: {
        firstName: applicant.firstName,
        addressLine1: application.property.addressLine1,
        ...extra,
      },
      propertyId: application.propertyId,
      idempotencyKey,
    })
    await dispatchPendingNotifications(new Date(), 50, {
      deliveryIds: outcomes.map((o) => o.deliveryId).filter((id): id is string => id != null),
    })
    return reachOf(outcomes)
  } catch (error) {
    console.error(`[screening] ${templateKey} failed for applicant ${applicant.id}`, error)
    return { status: 'NOT_SENT', why: 'sending failed' }
  }
}
