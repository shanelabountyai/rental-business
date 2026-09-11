'use server'

import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { actorCan, propertyResource, requireScope } from '@/lib/auth/guard.ts'
import { renderForRecipient } from '@/lib/comms/templates.ts'
import { getTemplate } from '@/lib/comms/templates.ts'
import { leasesHalted } from '@/lib/holds/queries.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { businessDate } from '@rental/core/scheduling'
import { chaseParties } from './chase-parties.ts'
import { pastGraceLeaseIds } from './rent-roll.ts'

// "Select everyone past grace and fire the templated reminder in one action"
// (PAY-06, R-044).
//
// ==========================================================================
// THE HIGHEST BLAST-RADIUS ACTION IN THIS PRODUCT. Everything else here
// touches one tenancy; one press of this touches every tenancy somebody
// ticked. Four rules follow from that, and none of them is optional.
//
//   1. IT SENDS TO AN EXPLICIT SELECTION, never to a filter. "Everyone past
//      grace" is how the list is BUILT; what is sent to is the set of lease
//      ids that came back in the form. A filter re-evaluated at send time can
//      have changed between the screen rendering and the button being pressed
//      — somebody pays at 6:02am — and the person pressing it would have
//      chased a tenant who does not appear on the list they were looking at.
//
//   2. A RECIPIENT WITH AN UNFILLABLE MERGE FIELD IS SKIPPED, NOT SENT. R-049
//      made `renderTemplate` report what it could not fill precisely so this
//      caller can refuse. One tenant receiving "You owe {{balance.total}}"
//      undoes more trust than the whole batch builds.
//
//   3. PAST GRACE IS RE-CHECKED SERVER-SIDE. The checkbox is an affordance.
//      Chasing a tenant inside their statutory grace period is the fair-housing
//      exposure this whole item is shaped around, and a stale page or a
//      crafted post must not be able to cause it.
//
//   4. IDEMPOTENT PER RECIPIENT PER DAY. Double-pressing sends once. The
//      engine's own key is the guarantee, and it is keyed on the FACT (this
//      lease, this template, this person, today) rather than on the attempt.
//
//   5. IT REACHES EVERY PARTY WHO CAN PAY, not the first name on the lease
//      (R-179). This used to take `leaseTenants.find(t => t.active)` — so on
//      a two-tenant lease the roommate actually holding the money heard
//      nothing, and no guarantor had ever been sent a chase at all. Both are
//      liable; addressing one of them and calling the tenancy chased is how a
//      balance runs all the way to a notice with the person who would have
//      paid it never having been told. Skips are recorded PER PERSON, for the
//      same reason the skips are recorded at all.
// ==========================================================================

export interface ReminderFormState {
  error?: string
  notice?: string
}

export async function sendReminders(
  _previous: ReminderFormState,
  formData: FormData,
): Promise<ReminderFormState> {
  // `requireScope`, NOT a bare `requirePermission('message.send')`. A
  // property-scoped manager holds message.send over their own properties and
  // nowhere else, and a resource-less check sends exactly the person whose
  // job this is to /no-access. Each lease is then checked against ITS OWN
  // property below — which is the part that matters, because a bulk action
  // taking a list of ids from a form must never send to a tenancy the caller
  // cannot see.
  const { actor } = await requireScope('message.send')

  const templateId = String(formData.get('templateId') ?? '')
  const leaseIds = formData.getAll('leaseIds').map(String).filter(Boolean)

  if (!templateId) return { error: 'Choose a template to send.' }
  if (leaseIds.length === 0) {
    return { error: 'Nobody is selected. Tick the tenants you want to remind.' }
  }

  const template = await getTemplate(templateId)
  if (!template || !template.active) {
    return { error: 'That template is no longer available.' }
  }

  const leases = await prisma.lease.findMany({
    where: { id: { in: leaseIds } },
    select: {
      id: true,
      propertyId: true,
      property: {
        select: { id: true, legalEntityId: true, state: true, county: true, timezone: true },
      },
      leaseTenants: {
        select: {
          tenant: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              preferredLocale: true,
              active: true,
            },
          },
        },
      },
      // RULE 5. Active only — a released guarantor is no longer liable, and
      // chasing one for a debt they are off the hook for is its own problem.
      guarantors: {
        where: { active: true },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
      },
    },
  })

  // RULE 3, recomputed from the database immediately before sending. Between
  // the page rendering and this press a tenant can have paid, and a crafted
  // post can name any lease at all.
  const chaseable = await pastGraceLeaseIds(leaseIds)
  // WHY a lease was dropped, not just that it was. `pastGraceLeaseIds`
  // subtracts held leases from the same set as paid ones, so a bare "not in
  // the set" cannot tell a tenant who paid from a tenancy under an automatic
  // stay — and reporting the second as the first is worse than saying
  // nothing: it sends somebody looking for a payment that was never made,
  // and it writes that fiction into the audit row below. Under a protection,
  // the reason a chase was withheld IS the record (Golden Path 5, D-134).
  const held = await leasesHalted(leaseIds, 'halt_dunning')

  /// Lease ids that got at least one message out. Distinct from `sentTo`
  /// below: "sent to 3 people on 2 tenancies" is the sentence a PM needs, and
  /// counting either one alone hides the other.
  const sent = new Set<string>()
  const sentTo: string[] = []
  const skipped: { leaseId: string; who: string; why: string }[] = []
  const deliveryIds: string[] = []

  for (const lease of leases) {
    // PER-LEASE AUTHORISATION, against that lease's own property. The form
    // supplies ids; a crafted post can name any lease in the database, and
    // "you hold message.send somewhere" is not permission to message here.
    if (!(await actorCan('message.send', propertyResource(lease.property)))) {
      skipped.push({ leaseId: lease.id, who: 'the tenancy', why: 'outside your properties' })
      continue
    }

    if (!chaseable.has(lease.id)) {
      // Paid since the page rendered, never past grace at all, or held.
      // Skipped rather than refused for the batch, so one stale row does not
      // stop the other forty going out.
      skipped.push({
        leaseId: lease.id,
        who: 'the tenancy',
        why: held.has(lease.id)
          ? 'under a hold that stops the chase'
          : 'not past the grace period',
      })
      continue
    }

    const parties = chaseParties(lease)
    if (parties.length === 0) {
      skipped.push({ leaseId: lease.id, who: 'the tenancy', why: 'nobody active to write to' })
      continue
    }

    // RULE 5. Every liable party, each rendered and refused on its own
    // merits: one guarantor with no email must not stop the tenant's
    // reminder, and a tenant who bounces must not stop the guarantor's.
    for (const party of parties) {
      const rendered = await renderForRecipient(template, {
        leaseId: lease.id,
        tenantId: party.type === 'TENANT' ? party.id : null,
        guarantorId: party.type === 'GUARANTOR' ? party.id : null,
        tenantName: party.name,
        preferredLocale: party.preferredLocale,
        email: party.email,
        phone: party.phone,
      })
      if (!rendered) {
        skipped.push({ leaseId: lease.id, who: party.name, why: 'could not build the message' })
        continue
      }

      // RULE 2. R-049 reports unfillable fields rather than blanking them
      // exactly so this refuses here.
      if (rendered.missing.length > 0) {
        skipped.push({
          leaseId: lease.id,
          who: party.name,
          why: `nothing to put in ${rendered.missing.join(', ')}`,
        })
        continue
      }

      const outcomes = await notify({
        category: 'rent_reminder',
        templateKey: 'comms.managed_template',
        recipient: {
          type: party.type,
          id: party.id,
          email: party.email,
          phone: party.phone,
        },
        context: { subject: rendered.subject, body: rendered.body },
        propertyId: lease.propertyId,
        // Keyed on the FACT — this lease, this template, THIS PERSON, this
        // property-local day — so a double press sends once and a retry
        // tomorrow is a deliberately different message. The person is in the
        // key because two people on one lease are two genuinely different
        // messages, and a lease-level key would send to whoever came first
        // and swallow the rest as duplicates.
        idempotencyKey: `reminder:${templateId}:${lease.id}:${party.type}:${party.id}:${businessDate(
          new Date(),
          lease.property.timezone,
        )}`,
      })

      sent.add(lease.id)
      sentTo.push(party.id)
      for (const outcome of outcomes) {
        if (outcome.deliveryId) deliveryIds.push(outcome.deliveryId)
      }
    }
  }

  if (deliveryIds.length > 0) {
    // Only OUR rows. An unfiltered sweep would make this pay for the whole
    // global backlog, and the suite rule exists for the same reason.
    await dispatchPendingNotifications(new Date(), 200, { deliveryIds }).catch((error) => {
      console.error('[reminders] dispatch failed', error)
    })
  }

  await audit({
    action: 'message.bulk_sent',
    entityType: 'MessageTemplate',
    entityId: templateId,
    after: {
      templateName: template.name,
      requested: leaseIds.length,
      sent: sent.size,
      // BOTH NUMBERS. "Sent to 12" against 9 selected tenancies is the record
      // that says the chase reached roommates and guarantors rather than the
      // one name at the top of each lease.
      sentToPeople: sentTo.length,
      // THE SKIPS ARE RECORDED, not just counted. "Why did this tenant not
      // get the reminder we sent everybody" is the question somebody asks
      // three weeks later, and a bare count cannot answer it.
      skipped,
      sentByStaffId: actor.id,
    },
  }).catch((error) => {
    console.error('[reminders] audit failed', error)
  })

  revalidatePath('/money/rent-roll')

  if (sentTo.length === 0) {
    return { error: `Nothing was sent. ${describeSkips(skipped)}` }
  }
  // PEOPLE AND TENANCIES, both counted. The old copy said "sent to N tenants"
  // where N was a count of LEASES, which was already only accidentally true
  // and is plainly false now that a two-tenant lease gets two messages.
  const reach = `${sentTo.length} ${sentTo.length === 1 ? 'person' : 'people'} on ${sent.size} ${
    sent.size === 1 ? 'tenancy' : 'tenancies'
  }`
  return {
    notice:
      skipped.length === 0
        ? `Reminder sent to ${reach}.`
        : `Reminder sent to ${reach}, of ${leaseIds.length} selected. ${describeSkips(skipped)}`,
  }
}

/// Names the reasons rather than the count. A PM who sent 40 of 45 needs to
/// know the 5 were missing a balance, not that "5 failed".
function describeSkips(skipped: { who: string; why: string }[]): string {
  if (skipped.length === 0) return ''
  const reasons = [...new Set(skipped.map((s) => s.why))]
  return `Skipped ${skipped.length}: ${reasons.join('; ')}.`
}
