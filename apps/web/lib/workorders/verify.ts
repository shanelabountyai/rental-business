import 'server-only'

import { businessDate } from '@rental/core/scheduling'
import { type Priority, prisma } from '@rental/db'
import { authUrl } from '@/lib/auth/delivery.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { createTask } from '@/lib/tasks/create.ts'

// The verification ask, and what a "no" does (MAINT-07, R-030).
//
// Split from actions.ts because both a staff action (marking work complete)
// and a vendor action through a magic link (R-025's completion upload) have
// to be able to ask the tenant, and neither is allowed to import the other's
// `'use server'` module.

/**
 * Asks the tenant whether the work is actually fixed.
 *
 * Safe to call more than once for the same round: the notification's own
 * idempotency key is the guarantee, so a work order marked complete twice
 * asks once, and a REOPENED job asks again because the round has moved.
 *
 * Never throws into its caller. The work IS complete whether or not the
 * message went out; failing the completion because a provider was down would
 * lose the fact that matters in order to protect the one that does not.
 */
export async function requestVerification(workOrderId: string): Promise<void> {
  try {
    const workOrder = await prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: {
        id: true,
        propertyId: true,
        reopenCount: true,
        scope: true,
        property: { select: { addressLine1: true } },
        ticket: {
          select: {
            id: true,
            description: true,
            tenant: {
              select: { id: true, email: true, phone: true, firstName: true },
            },
          },
        },
      },
    })

    // No ticket means nobody reported this - a PM raised it themselves, and
    // there is no tenant whose answer would mean anything. Not an error:
    // `closeDecision()` already treats an unanswered job as closable and
    // says so.
    const tenant = workOrder?.ticket?.tenant
    if (!workOrder || !tenant) return

    const outcomes = await notify({
      category: 'maintenance_update',
      templateKey: 'workorder.verify_request',
      recipient: {
        type: 'TENANT',
        id: tenant.id,
        email: tenant.email,
        phone: tenant.phone,
      },
      context: {
        tenantName: tenant.firstName,
        // The TENANT's words, not the internal scope. "Water heater leaking"
        // is what they will recognise; "R/R T&P valve, 40gal" is not.
        requestSummary: workOrder.ticket?.description.slice(0, 120) ?? workOrder.scope,
        addressLine1: workOrder.property.addressLine1,
        // ABSOLUTE, from AUTH_URL. A relative path in an SMS is not a link
        // - it is a string a tenant cannot tap, on the one message whose
        // entire value is the tap. Built the same way every other outbound
        // link in the product is (auth/delivery.ts), and deliberately not
        // from the request Host header for the reason stated there.
        url: authUrl(`/portal/maintenance/${workOrder.ticket?.id}`),
      },
      propertyId: workOrder.propertyId,
      // Keyed on the ROUND, so a reopened job asks again and a job marked
      // complete twice does not.
      idempotencyKey: `workorder-verify:${workOrder.id}:${workOrder.reopenCount + 1}`,
    })

    const deliveryIds = outcomes
      .map((outcome) => outcome.deliveryId)
      .filter((id): id is string => id != null)
    if (deliveryIds.length > 0) {
      await dispatchPendingNotifications(new Date(), 50, { deliveryIds })
    }
  } catch (error) {
    console.error(`[verify] could not ask the tenant about ${workOrderId}`, error)
  }
}

/**
 * A tenant's "no": the job goes back, with the reason attached.
 *
 * Status returns to SUBMITTED - the same "a human has to decide what happens
 * next" state R-025's vendor decline uses - but the vendor is deliberately
 * NOT cleared the way a decline clears it. A decline means that vendor is
 * not doing the job; a reopen means their work came back, and the PM needs
 * to see whose it was while deciding whether to send them again or somebody
 * else. The attribution that feeds the reopen-rate report is already safe
 * either way: it was captured on the verification row.
 */
export async function reopenWorkOrder(
  workOrder: {
    id: string
    propertyId: string
    scope: string
    priority: Priority
    reopenCount: number
    property: { timezone: string }
    unit: { name: string }
  },
  comment: string | null,
  now = new Date(),
): Promise<void> {
  await createTask(prisma, {
    propertyId: workOrder.propertyId,
    type: 'workorder_reopened',
    subjectType: 'WorkOrder',
    subjectId: workOrder.id,
    businessDate: businessDate(now, workOrder.property.timezone),
    // Carries the work order's own priority rather than being raised to
    // urgent: a dripping tap that is still dripping is still a dripping tap,
    // and inflating every reopen would push genuinely urgent work down the
    // queue.
    priority: workOrder.priority,
    // The tenant's own words in the title where they gave any. A PM
    // triaging a queue decides what to do next from this line, and "still
    // dripping under the sink" is a different job from "you never came".
    title: comment?.trim()
      ? `Tenant says it is not fixed: "${comment.trim().slice(0, 60)}" (${workOrder.unit.name})`
      : `Tenant says it is not fixed — ${workOrder.scope.slice(0, 40)} (${workOrder.unit.name})`,
  })
}

/**
 * A tenant's "yes": the job is ready to be closed, and somebody has to do it.
 *
 * THE COUNTERPART TO `reopenWorkOrder`, and it was missing. A "no" raised a
 * Task and a "yes" raised nothing, which sounds right - one is a problem and
 * one is not - but "yes" is the point at which the job stops being
 * maintenance and starts being money: the invoice arrives, the cost has to be
 * recorded against the property, and nothing else in the system will ever
 * mention this work order again. Without a Task it sat in VERIFIED silently
 * until somebody happened to open it.
 *
 * Deliberately ROUTINE whatever the job's own priority was, and unlike
 * `reopenWorkOrder` which carries the job's priority through. An emergency
 * that has been FIXED and confirmed is no longer an emergency; it is
 * bookkeeping, and paging it as urgent trains people to ignore the urgent
 * queue. A reopen is the opposite case - the emergency is still live.
 */
export async function readyToCloseTask(
  workOrder: {
    id: string
    propertyId: string
    scope: string
    property: { timezone: string }
    unit: { name: string }
  },
  now = new Date(),
): Promise<void> {
  await createTask(prisma, {
    propertyId: workOrder.propertyId,
    type: 'workorder_ready_to_close',
    subjectType: 'WorkOrder',
    subjectId: workOrder.id,
    businessDate: businessDate(now, workOrder.property.timezone),
    priority: 'ROUTINE',
    title: `Close out: ${workOrder.scope.slice(0, 50)} (${workOrder.unit.name})`,
  })
}

/// Every answer that has ever been given about this job, newest first. The
/// PM's own view of "what did the tenant actually say", which a single
/// `verifiedAt` column could never hold once a job has come back twice.
export async function verificationsFor(workOrderId: string) {
  return prisma.workOrderVerification.findMany({
    where: { workOrderId },
    orderBy: { round: 'desc' },
    include: { vendor: { select: { name: true } } },
  })
}

/**
 * How often this vendor's work comes back (MAINT-07, MAINT-10).
 *
 * Reads `WorkOrderVerification.vendorId` - the vendor captured when the
 * tenant answered - and never the work order's current vendor. See the
 * schema comment on that column for why the difference is the whole point.
 */
export async function vendorVerificationRows(vendorId: string) {
  return prisma.workOrderVerification.findMany({
    where: { vendorId },
    select: { vendorId: true, resolved: true, rating: true },
  })
}

/// The cost of every closed job at a property (MAINT-07's "attach to the
/// property and flow to reporting"). One number per job, read from the work
/// order itself - there is no second place the money is entered, which is
/// exactly what "no re-keying" means.
export async function closedJobCostsForProperty(propertyId: string) {
  return prisma.workOrder.findMany({
    where: { propertyId, status: 'CLOSED' },
    select: {
      id: true,
      scope: true,
      closedAt: true,
      actualLaborCents: true,
      actualMaterialsCents: true,
      invoiceCents: true,
      tenantCaused: true,
      vendor: { select: { id: true, name: true } },
      unit: { select: { id: true, name: true } },
    },
    orderBy: { closedAt: 'desc' },
  })
}
