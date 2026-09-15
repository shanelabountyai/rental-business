import 'server-only'

import { authUrl } from '@/lib/auth/delivery.ts'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { CONSUMERS } from '@/lib/jobs/outbox.ts'
import { notify } from '@/lib/notifications/send.ts'
import type { TemplateChecklistItem } from '@rental/core/inspections'

// R-208 (INSP-01/INSP-02). A tenancy going live opens its own move-in
// condition report, so the deposit case has a left-hand side without anybody
// remembering to press a button.
//
// WHAT WAS WRONG. A MOVE_IN inspection was created in exactly one place - a
// staff member on /inspections/new. Nothing else made one, and the job that
// looks like the safety net is not one: `inspection.move_in_overdue` selects
// `{ type: 'MOVE_IN', selfGuided: true, performedAt: null }`, so it needs the
// row to exist before it can complain that nobody walked it. The asymmetry
// was provable in two filenames - pre-move-out-scheduling-job.ts opens its
// inspection automatically and there was no move-in equivalent.
//
// WHAT IT COST. The whole deposit case. `itemsFromMoveIn` builds R-070/
// R-151's side-by-side from `{ leaseId, type: 'MOVE_IN' }`, so with none the
// comparison has nothing on the left and every deduction trips
// `isUnsupportedDeduction` (packages/core/ledger/disposition.ts) - which is
// the correct answer to an unevidenced deduction and the wrong answer to a
// real one nobody was given the chance to evidence.
//
// A CONSUMER, NOT A HOOK IN THE ACTIONS. "Lease activation" reads like four
// call sites (`leaseTransition` in actions.ts, esign-actions.ts,
// esign-staff-actions.ts, renewal-cutover-job.ts) and is in fact ONE write:
// all three that actually reach ACTIVE route through
// `activateLeaseSideEffects`, which emits `lease.activated` exactly once
// (esign-staff-actions.ts goes to PENDING_SIGNATURE and is not an activation
// at all). Reacting to the event rather than editing the callers is the same
// call delist-consumer.ts already made on this event, and for the stated
// reason: a fifth way to go live - the DRAFT lease an import wrote, activated
// by hand months later - needs nothing added here.
//
// WARN, NEVER BLOCK (D-187, and D-222 makes it binding for this item). None
// of this can stop occupancy. A family must not be held on the doorstep on a
// Saturday because nobody configured a checklist; the loud half lives in
// deposit-clearing-job.ts, on the Task that releases the access codes.

CONSUMERS.push({
  name: 'open-move-in-inspection',
  event: 'lease.activated',
  handle: async (tx, event) => {
    const lease = await tx.lease.findUnique({
      where: { id: event.aggregateId },
      select: {
        id: true,
        unitId: true,
        propertyId: true,
        origin: true,
        unit: { select: { name: true } },
        property: { select: { addressLine1: true } },
      },
    })
    if (!lease) return

    // A renewal is not a move-in. The tenant has been in the house for a
    // year; asking them to photograph it as though they had just arrived
    // records the wrong fact, and the overdue job would then nag them for
    // seven days about a walk that should never have been asked for. The
    // successor's deposit case reads the PREDECESSOR's move-in report, which
    // is the correct baseline - `endRenewalPredecessor` moves the Deposit
    // rows across and the condition at the true start of occupancy is what a
    // deduction has to be measured from.
    //
    // INHERITED is deliberately NOT excluded. The tenant did not move in
    // either, but nobody has ever recorded what this house looked like - it
    // is the case with the LEAST baseline, not the most, and `itemsFromMoveIn`
    // already names it as a known hole ("an inherited tenancy with no
    // application-derived baseline"). Asking the sitting tenant to walk it at
    // takeover is the only chance anyone gets.
    if (lease.origin === 'RENEWAL') return

    // Idempotent on the fact, not just on EventConsumption's claim. The claim
    // already stops a retry running this twice; this stops a lease that
    // somehow activates again from stacking a second blank report on top of
    // a walked one, and it is what makes the whole consumer safe to deploy
    // against a database full of live tenancies (D-201: never backfill - an
    // already-active lease emits no event and gets nothing).
    const existing = await tx.inspection.findFirst({
      where: { leaseId: lease.id, type: 'MOVE_IN' },
      select: { id: true },
    })
    if (existing) return

    // Nothing on file, so nothing happens - the posture
    // periodic-scheduling-job.ts already takes, and the reason the access-code
    // Task carries the warning: a report that cannot be opened here is still
    // announced there, so the gap is never silent even though it is never
    // blocking. An inspection with zero items would be WORSE than none -
    // `canFinishInspection` refuses an empty checklist, so it could never be
    // completed, and the overdue job would raise a Task every day about a
    // report no one could ever satisfy.
    const template = await tx.inspectionTemplate.findFirst({
      where: { defaultForType: 'MOVE_IN', active: true },
      select: { id: true, name: true, items: true },
    })
    if (!template) return

    const checklist = template.items as unknown as TemplateChecklistItem[]
    if (!Array.isArray(checklist) || checklist.length === 0) return

    // selfGuided, because the alternative is a report only the overdue job's
    // blind spot watches: `inspection.move_in_overdue` filters on this flag,
    // so a staff-performed row opened here would be invisible to the very job
    // this item exists to give something to watch. The flag only ADDS a
    // permission - staff can still walk it themselves from /inspections/[id],
    // and the day-7 escalation hands them exactly that choice.
    const inspection = await tx.inspection.create({
      data: {
        propertyId: lease.propertyId,
        unitId: lease.unitId,
        leaseId: lease.id,
        type: 'MOVE_IN',
        selfGuided: true,
        templateId: template.id,
        items: {
          create: checklist.map((row, index) => ({
            room: row.room,
            item: row.item,
            order: index,
          })),
        },
      },
    })

    await auditAsSystem(
      'lease-activated',
      {
        action: 'inspection.created',
        entityType: 'Inspection',
        entityId: inspection.id,
        propertyId: lease.propertyId,
        after: {
          type: 'MOVE_IN',
          selfGuided: true,
          reason: 'lease_activated',
          leaseId: lease.id,
          templateId: template.id,
          templateName: template.name,
          itemCount: checklist.length,
        },
      },
      tx,
    )

    // The primary tenant, in the dispatcher's own transaction - the posture
    // notifications/consumers.ts states at length: the notification and the
    // EventConsumption row that marks the event handled commit together, and
    // `notify`'s idempotency key refuses the duplicate on a retry. NOT the
    // best-effort try/catch `startInspection` uses, which is right for a
    // staff member standing at a form and wrong here: a throw leaves the
    // event unpublished and retried, which is what we want from a send that
    // failed.
    const primary = await tx.leaseTenant.findFirst({
      where: { leaseId: lease.id, isPrimary: true },
      select: {
        tenant: { select: { id: true, firstName: true, email: true, phone: true } },
      },
    })
    if (!primary) return

    await notify(
      {
        category: 'inspection_signature',
        templateKey: 'inspection.move_in_ready',
        recipient: {
          type: 'TENANT',
          id: primary.tenant.id,
          email: primary.tenant.email,
          phone: primary.tenant.phone,
        },
        context: {
          tenantName: primary.tenant.firstName,
          addressLine1: lease.property.addressLine1,
          unitName: lease.unit.name,
          url: authUrl(`/portal/papers/inspections/${inspection.id}`),
        },
        propertyId: lease.propertyId,
        eventId: event.id,
        idempotencyKey: `inspection-move-in-ready:${inspection.id}`,
      },
      tx,
    )
  },
})
