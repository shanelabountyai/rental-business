import 'server-only'

import type { ProjectionIntent } from '@rental/core/billing'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { notify } from '@/lib/notifications/send.ts'

// The application-fee half of the Stripe webhook pipeline (R-059).
//
// A SEPARATE SMALL PROJECTOR, NOT A DETOUR THROUGH THE LEDGER. An
// application fee has no lease and no LeasePayer, and it never becomes a
// LedgerEntry - D-11's projection is scoped to tenancy money, and an
// applicant is not a tenant yet. `billing/webhook.ts` calls
// `findApplicantByStripeCustomer` BEFORE its own LeasePayer lookup, which
// would otherwise find nothing for an applicant's customer id and silently
// "ignore" the one event that confirms the fee actually cleared.

export interface ApplicantForFeeEvent {
  id: string
  applicationId: string
  firstName: string
}

export async function findApplicantByStripeCustomer(
  stripeCustomerId: string | null,
): Promise<ApplicantForFeeEvent | null> {
  if (!stripeCustomerId) return null
  return prisma.applicant.findFirst({
    where: { stripeCustomerId },
    select: { id: true, applicationId: true, firstName: true },
  })
}

/**
 * Projects one Stripe event onto an Applicant. Idempotent by construction:
 * the `feePaidAt: null` guard in the update means a retried or duplicated
 * `payment_intent.succeeded` writes nothing the second time, the same shape
 * `ProcessedStripeEvent`'s own claim gives the pipeline generally - this is
 * a second, narrower belt for the one field this projector owns.
 */
export async function projectApplicationFeeEvent(
  applicant: ApplicantForFeeEvent,
  intent: ProjectionIntent,
): Promise<string> {
  if (intent.kind !== 'payment_succeeded') {
    // `payment_pending`/`payment_failed` are acknowledged and logged but
    // change nothing here - an applicant whose card was declined simply
    // tries again from the same page, no state to unwind.
    return `application fee ${intent.kind} for applicant ${applicant.id}, no state change`
  }

  const updated = await prisma.applicant.updateMany({
    where: { id: applicant.id, feePaidAt: null },
    data: { feePaidAt: intent.occurredAt, stripePaymentIntentId: intent.stripePaymentIntentId },
  })
  if (updated.count === 0) {
    return `applicant ${applicant.id} fee already recorded`
  }

  await auditAsSystem(`applicant:${applicant.id}`, {
    action: 'application.fee_paid',
    entityType: 'Applicant',
    entityId: applicant.id,
    after: { feeCents: intent.amountCents },
  })

  const fresh = await prisma.applicant.findUniqueOrThrow({
    where: { id: applicant.id },
    include: { application: { include: { property: true } } },
  })

  await notify({
    category: 'prospect_application',
    templateKey: 'application.fee_paid',
    recipient: { type: 'APPLICANT', id: applicant.id, email: fresh.email, phone: fresh.phone },
    context: {
      firstName: fresh.firstName,
      addressLine1: fresh.application.property.addressLine1,
      amountCents: intent.amountCents,
    },
    propertyId: fresh.application.propertyId,
    // Natural key, not the Stripe event id - a retried delivery of the same
    // event must send zero notifications the second time, not a second
    // confirmation for money already confirmed once.
    idempotencyKey: `applicant-fee-paid:${applicant.id}`,
  })

  await completeApplicantIfDone(applicant.id, applicant.applicationId)

  return `applicant ${applicant.id} fee paid`
}

/**
 * The other half of the two-part completion state (schema's own comment on
 * `Applicant.completedAt`): the form was already validated and submitted
 * (`formSubmittedAt`), and now the fee has cleared - or never applied. Once
 * both are true for every applicant in the group, the household is done and
 * `Application.completedAt` is the "completion timestamp" R-060 will read.
 */
export async function completeApplicantIfDone(
  applicantId: string,
  applicationId: string,
): Promise<void> {
  const applicant = await prisma.applicant.findUniqueOrThrow({ where: { id: applicantId } })
  if (!applicant.formSubmittedAt || applicant.completedAt) return
  if (!applicant.feePaidAt && applicant.feeCents) return

  await prisma.applicant.update({
    where: { id: applicantId },
    data: { completedAt: new Date() },
  })

  await maybeCompleteApplication(applicationId)
}

async function maybeCompleteApplication(applicationId: string): Promise<void> {
  const application = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    include: { applicants: { select: { completedAt: true } } },
  })
  if (application.completedAt) return
  if (application.applicants.some((a) => !a.completedAt)) return

  await prisma.$transaction(async (tx) => {
    await tx.application.update({ where: { id: applicationId }, data: { completedAt: new Date() } })
    await tx.prospect.update({
      where: { id: application.prospectId },
      data: { status: 'APPLIED' },
    })
    await auditAsSystem(
      `application:${applicationId}`,
      {
        action: 'application.completed',
        entityType: 'Application',
        entityId: applicationId,
        propertyId: application.propertyId,
      },
      tx,
    )
  })
}
