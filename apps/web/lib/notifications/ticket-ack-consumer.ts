import 'server-only'

import { reportedWords, ticketReference } from '@rental/core/maintenance'
import { CONSUMERS } from '@/lib/jobs/outbox.ts'
import { notify } from './send.ts'

// Its own module, not a third entry in consumers.ts, and the reason is a
// TEST one: consumers.ts also registers `notify-unit-make-ready`, and
// CONSUMERS is a plain array shared across every file in a Vitest worker -
// so a test importing it to reach this consumer silently arms that one for
// units/auto-make-ready.test.ts too. triage-consumer.ts's own header
// records that exact failure happening. One consumer per module is what
// makes it importable in isolation.

/**
 * A tenant who reported a problem hears something back (MAINT-01, COMM-03,
 * NOTIF-01, R-181).
 *
 * ON THE EVENT, NOT AT THE FIVE INTAKE SITES. The portal wizard, the
 * emergency form, the phone-logged form, SMS intake and email intake each
 * already emit `ticket.created`, so one reaction covers all five and the
 * sixth intake path somebody adds later gets it without knowing this exists -
 * the same call R-023's triage consumer made about the same event.
 *
 * ponytail: delivery is the hourly cron's, like everything else on this bus,
 * so the receipt can lag the request by up to an hour. That is the trade the
 * whole bus already makes and it is a large improvement on what it replaces
 * (nothing, until an entry notice days later). A genuine emergency does not
 * wait on it either - `pageOnCall` reaches staff in the submitting request.
 */
CONSUMERS.push({
  name: 'notify-ticket-acknowledged',
  event: 'ticket.created',
  handle: async (tx, event) => {
    const ticket = await tx.ticket.findUnique({
      where: { id: event.aggregateId },
      select: {
        id: true,
        propertyId: true,
        source: true,
        description: true,
        priority: true,
        property: { select: { addressLine1: true } },
        tenant: { select: { id: true, firstName: true, email: true, phone: true } },
      },
    })
    if (!ticket) return
    // Nobody to acknowledge. A ticket with no tenant is one staff opened
    // against a unit - a turn punch-list item, a vacant-unit repair - and
    // there is no reporter waiting to hear back.
    const tenant = ticket.tenant
    if (!tenant) return

    // A TEXTED-IN REQUEST IS ALREADY ANSWERED, IN SECONDS, ON THE CHANNEL IT
    // ARRIVED ON. `inviteToClarify` (R-177) replies to SMS intake inside
    // Twilio's own webhook with "Got it - we have your request for X", and a
    // second "we have your request" an hour later is how a helpful reply
    // becomes spam - the same judgment that item's own idempotency key made
    // about three texts on one leak.
    //
    // Checked on the SOURCE rather than on whether a clarify notification
    // exists: `notify()` writes a row per channel even when it suppresses,
    // so "a clarify row exists" is also true for a tenant who has MUTED
    // `maintenance_clarify` - and muting the checklist must not mute the
    // receipt, which is the whole reason these are two categories.
    //
    // What this costs: a texted-in tenant never gets the quotable reference,
    // and gets nothing at all in the rare case where clarify was correctly
    // silent. Both are recorded in PROGRESS rather than solved here.
    if (ticket.source === 'SMS') return

    await notify(
      {
        category: 'maintenance_ack',
        templateKey: 'ticket.acknowledged',
        recipient: {
          type: 'TENANT',
          id: tenant.id,
          email: tenant.email,
          phone: tenant.phone,
        },
        context: {
          tenantName: tenant.firstName,
          reference: ticketReference(ticket.id),
          // The tenant's own words, not the whole transcript - an email
          // repeating back every prompt they just answered reads as a
          // machine, and an SMS cannot carry it at all.
          requestSummary: reportedWords(ticket.description).slice(0, 120),
          addressLine1: ticket.property.addressLine1,
          isEmergency: ticket.priority === 'EMERGENCY',
        },
        propertyId: ticket.propertyId,
        eventId: event.id,
        // The TICKET, not the event: one receipt per request, ever. A retry
        // of this consumer must not text somebody a second time.
        idempotencyKey: `ticket-ack:${ticket.id}`,
      },
      tx,
    )
  },
})
