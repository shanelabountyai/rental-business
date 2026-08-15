'use server'

import { formatCents } from '@rental/core/money'
import { utcToBusinessDate } from '@rental/core/scheduling'
import { chargebackDecision, chargebackNoticeText } from '@rental/core/workorders'
import type { ChargebackRefusal } from '@rental/core/workorders'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { authUrl } from '@/lib/auth/delivery.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import { isUniqueViolation } from '@/lib/db/unique-violation.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { chargebackContext } from './chargeback.ts'
import type { WorkOrderFormState } from './actions.ts'

// Billing a tenant for a repair they caused (MAINT-07, R-031).
//
// ==========================================================================
// ITS OWN ACTION, BEHIND `ledger.adjust`, AND THAT IS THE POINT (D-43).
//
// The obvious build is a checkbox on the close form: close the job, bill the
// tenant, one press. It was rejected for two reasons that both showed up the
// moment the flow was drawn out.
//
//   PERMISSION. `closeWorkOrder` runs on `workorder.write` — the permission a
//   maintenance coordinator has. Every other money-moving action in this
//   product sits behind `ledger.adjust`, and posting a charge from inside the
//   close would have quietly made "can close a job" mean "can bill a tenant".
//
//   THE AMOUNT IS A DECISION, NOT THE INVOICE. Partial fault, betterment, a
//   goodwill split — billing part of a repair is the normal outcome, and a
//   flow welded to the close form can only ever charge the full invoice.
//
// The cost of splitting them is that a job can be flagged tenant-caused and
// never billed. That is paid for at the close, which raises a Task (D-9) so
// the decision sits in a queue rather than in somebody's memory.
// ==========================================================================

const REFUSALS: Record<ChargebackRefusal, string> = {
  not_closed: 'Close the job first. Billing for work that could still be reopened or redone under warranty is a charge you may have to reverse.',
  not_tenant_caused: 'This job was not closed as tenant-caused, so there is nothing to bill. Reopen and close it again if the cause was recorded wrongly.',
  no_cost: 'This job has no recorded cost, so there is nothing to apportion. Add the invoice first.',
  no_tenancy: 'There is no tenancy on this job to bill — no ticket, and no live lease on the unit.',
  already_charged: 'This job has already been billed to the tenant.',
  zero_requested: 'Enter the amount to charge the tenant, in whole cents above zero.',
  exceeds_job_cost: 'You cannot charge the tenant more than the repair cost. Charge less if only part of it is theirs.',
}

/**
 * Posts the chargeback, serves the notice, and tells the tenant.
 *
 * ORDERED SO THE TENANT IS NEVER BILLED SILENTLY. The Charge is written
 * first — it is the thing the database can make idempotent — then pushed,
 * then the notice and the message. A failure after the Charge leaves a
 * visible, recoverable row; a failure before it leaves nothing at all. The
 * one order that is not acceptable is a message promising a charge that was
 * never posted.
 */
export async function postChargeback(
  workOrderId: string,
  _previous: WorkOrderFormState,
  formData: FormData,
): Promise<WorkOrderFormState> {
  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    select: { id: true, property: true },
  })
  const actor = await requirePermission(
    'ledger.adjust',
    propertyResource(workOrder.property),
  )

  const context = await chargebackContext(workOrderId)
  if (!context) return { error: 'That job no longer exists.' }

  const amountRaw = formData.get('amountDollars')
  const amountDollars = typeof amountRaw === 'string' ? amountRaw.trim() : ''
  const reason = typeof formData.get('reason') === 'string'
    ? (formData.get('reason') as string).trim()
    : ''

  // REQUIRED, and required here rather than only at the audit layer so the
  // person gets a field error instead of a thrown MissingAuditReasonError.
  // The tenant's notice reproduces this verbatim — a chargeback with no
  // stated reason is indistinguishable from retaliation, which is the claim
  // it will be defended against.
  if (reason.length < 10) {
    return {
      error: 'Say why this repair is the tenant\'s cost.',
      fieldErrors: {
        reason: 'The tenant\'s notice quotes this back to them. A sentence, not a word.',
      },
    }
  }

  const requestedCents = amountDollars ? Math.round(Number(amountDollars) * 100) : 0
  const decision = chargebackDecision({
    status: context.status,
    tenantCaused: context.tenantCaused,
    jobCostCents: context.jobCostCents,
    leaseId: context.leaseId,
    existingChargeId: context.existingChargeId,
    requestedCents: Number.isFinite(requestedCents) ? requestedCents : 0,
  })
  if (!decision.allowed) {
    const message = REFUSALS[decision.refusal!]
    return decision.refusal === 'zero_requested' || decision.refusal === 'exceeds_job_cost'
      ? { error: message, fieldErrors: { amountDollars: message } }
      : { error: message }
  }

  const amountCents = decision.amountCents!
  const leaseId = context.leaseId!

  // The arithmetic on the charge itself, the same way a RUBS share and a
  // late fee carry theirs. A tenant reading "Repair charge" on a statement
  // has to go and ask; one reading "$150.00 of a $412.00 repair" does not.
  const description = decision.partial
    ? `Repair you were charged for — ${formatCents(amountCents)} of a ${formatCents(context.jobCostCents)} repair`
    : `Repair you were charged for — ${formatCents(context.jobCostCents)}`

  let charge
  try {
    charge = await prisma.charge.create({
      data: {
        propertyId: context.propertyId,
        leaseId,
        type: 'CHARGEBACK',
        amountCents,
        description,
        // Due today, in the property's own calendar (D-3). Not netted against
        // the next rent charge: a repair charge and rent are separate debts,
        // and the allocation order (D-11) decides what a payment settles.
        dueOn: new Date(utcToBusinessDate(new Date()) + 'T00:00:00.000Z'),
        // The evidence key AND the idempotency key. The partial unique index
        // is what actually prevents a double charge — two staff pressing this
        // within the same second would both pass a read-then-write check.
        workOrderId,
      },
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    return { error: REFUSALS.already_charged }
  }

  if (context.payer?.stripeCustomerId) {
    try {
      const item = await getBillingProvider().addInvoiceItem({
        stripeCustomerId: context.payer.stripeCustomerId,
        amountCents,
        currency: 'usd',
        description,
        chargeId: charge.id,
        // Keyed on the JOB, not on the attempt, so a retried submit adds the
        // invoice item once even if the Charge insert raced.
        idempotencyKey: `chargeback:${workOrderId}`,
      })
      await prisma.charge.update({
        where: { id: charge.id },
        data: { stripeInvoiceItemId: item.stripeInvoiceItemId },
      })
    } catch (error) {
      // The Charge stands. The tenant owes it and the ledger should say so;
      // a null `stripeInvoiceItemId` is the visible, recoverable state, and
      // the same one `assessNsfFee` leaves. Deliberately NOT a rollback —
      // deleting the charge would also lose the idempotency guarantee.
      console.error(`[chargeback] failed to push charge ${charge.id} to the provider`, error)
    }
  }

  const noticeBody = chargebackNoticeText({
    tenantName: context.tenant
      ? `${context.tenant.firstName} ${context.tenant.lastName}`
      : 'Resident',
    addressLine1: context.addressLine1,
    unitName: context.unitName,
    jobSummary: context.jobSummary,
    // `closedAt` is a real timestamp, so it is read in the PROPERTY's zone.
    completedOn: context.closedAt
      ? utcToBusinessDate(context.closedAt)
      : utcToBusinessDate(new Date()),
    jobCostCents: context.jobCostCents,
    amountCents,
    reason,
    evidenceCount: context.evidenceCount,
  })

  await prisma.$transaction(async (tx) => {
    const notice = await tx.notice.create({
      data: {
        propertyId: context.propertyId,
        leaseId,
        type: 'REPAIR_CHARGE',
        addressOfRecord: context.addressLine1,
        bodyText: noticeBody,
        serviceMethod: 'PORTAL',
        servedAt: new Date(),
        servedByStaffId: actor.id,
      },
    })
    await audit(
      {
        action: 'workorder.chargeback_posted',
        entityType: 'Charge',
        entityId: charge.id,
        propertyId: context.propertyId,
        after: {
          workOrderId,
          leaseId,
          amountCents,
          // BOTH numbers, always. "Was the tenant billed the whole repair?"
          // is the first question in a dispute and must not require joining
          // back to a work order whose costs could have moved since.
          jobCostCents: context.jobCostCents,
          partial: decision.partial === true,
          noticeId: notice.id,
          evidenceCount: context.evidenceCount,
        },
        reason,
      },
      tx,
    )
  })

  if (context.tenant) {
    const outcomes = await notify({
      category: 'legal_notice',
      templateKey: 'workorder.chargeback_posted',
      recipient: {
        type: 'TENANT',
        id: context.tenant.id,
        email: context.tenant.email,
        phone: context.tenant.phone,
      },
      context: {
        tenantName: context.tenant.firstName,
        addressLine1: context.addressLine1,
        jobSummary: context.jobSummary,
        amount: formatCents(amountCents),
        // Only when it differs — "the repair cost $412 and you owe $412"
        // twice is noise.
        jobCost: decision.partial ? formatCents(context.jobCostCents) : undefined,
        url: authUrl('/portal/pay/history'),
      },
      propertyId: context.propertyId,
      // Keyed on the job: one chargeback per job, so one message.
      idempotencyKey: `chargeback:${workOrderId}`,
    })
    // Only OUR rows, never the global sweep — the suite rule, and the right
    // behaviour in production too: this tenant should not wait on somebody
    // else's backlog to learn they have been billed.
    const deliveryIds = outcomes
      .map((outcome) => outcome.deliveryId)
      .filter((id): id is string => id != null)
    if (deliveryIds.length > 0) {
      await dispatchPendingNotifications(new Date(), 50, { deliveryIds }).catch((error) => {
        console.error(`[chargeback] failed to dispatch for charge ${charge.id}`, error)
      })
    }
  }

  revalidatePath(`/workorders/${workOrderId}`)
  revalidatePath('/workorders')

  return {
    notice: context.payer?.stripeCustomerId
      ? `Charged ${formatCents(amountCents)} and served the notice.`
      : `Charged ${formatCents(amountCents)} and served the notice. This tenant has no payment method set up, so nothing was sent to the payment provider yet.`,
  }
}
