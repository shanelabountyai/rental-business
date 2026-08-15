import 'server-only'

import { formatCents } from '@rental/core/money'
import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { authUrl } from '@/lib/auth/delivery.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'
import { issuePayLink } from '@/lib/portal/pay-link.ts'

// Due-soon (T-3) and due-date reminders (PAY-02, R-045).
//
// ==========================================================================
// FOR THE TENANT WHO HAS TO DO SOMETHING. `predebit.ts` warns an autopay
// tenant that money is about to be taken from them; this warns everyone
// ELSE that they need to go do the taking themselves.
//
// NOT SENT TO AN AUTOPAY TENANT WITH A METHOD ON FILE. Both halves, the
// exact test `predebit.ts` makes for the opposite reason: `predebit.ts` only
// warns a payer who genuinely will be debited, and this only warns a payer
// who genuinely has to act. A tenant on `charge_automatically` with a saved
// card is already covered by `autopay.predebit` two days out - sending them
// "rent is due soon, go pay it" as well tells them to do something the
// product is about to do FOR them, which reads as the product not knowing
// its own state.
// ==========================================================================

export interface DueNoticeResult {
  leasesChecked: number
  dueSoonSent: number
  dueTodaySent: number
}

/// Three days. The T in T-3.
const DUE_SOON_LEAD_DAYS = 3

/**
 * Warns every payer at this property who owes rent, and is not on autopay,
 * that their rent is due in three days or due today, in the property's own
 * local time.
 *
 * Idempotent per (payer, due date, which notice): the job runs daily, and
 * the key is the fact being announced rather than the attempt announcing it.
 */
export async function sendDueNotices(
  propertyId: string,
  now = new Date(),
): Promise<DueNoticeResult> {
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
    select: { timezone: true, addressLine1: true },
  })

  const today = businessDate(now, property.timezone)
  const soonTarget = new Date(now.getTime() + DUE_SOON_LEAD_DAYS * 86_400_000)
  const soonDate = businessDate(soonTarget, property.timezone)
  const todayDay = Number(today.slice(8, 10))
  const soonDay = Number(soonDate.slice(8, 10))

  const payers = await prisma.leasePayer.findMany({
    where: {
      propertyId,
      active: true,
      // NOT genuinely on autopay - see the module header. The payer's
      // CHOSEN day when they have one, the lease's day when they do not,
      // matching `predebit.ts` precisely so the two notices can never both
      // land on the same tenant for the same date.
      OR: [
        { debitDay: { in: [todayDay, soonDay] } },
        { debitDay: null, lease: { rentDueDay: { in: [todayDay, soonDay] } } },
      ],
      lease: { status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
    },
    select: {
      id: true,
      leaseId: true,
      debitDay: true,
      collectionMethod: true,
      defaultPaymentMethodId: true,
      stripeCustomerId: true,
      tenant: { select: { id: true, firstName: true, email: true, phone: true } },
      lease: { select: { rentCents: true, rentDueDay: true } },
    },
  })

  let dueSoonSent = 0
  let dueTodaySent = 0

  for (const payer of payers) {
    if (!payer.tenant) continue

    // ALREADY COVERED BY `autopay.predebit`. Both halves of the same check
    // `predebit.ts` makes: on automatic collection, AND a method on file to
    // actually collect from.
    if (payer.collectionMethod === 'charge_automatically' && payer.defaultPaymentMethodId) {
      continue
    }

    const dueDay = payer.debitDay ?? payer.lease.rentDueDay
    const isDueToday = dueDay === todayDay
    const isDueSoon = dueDay === soonDay
    if (!isDueToday && !isDueSoon) continue

    const idempotencyKey = `rent-due:${isDueToday ? 'today' : 'soon'}:${payer.id}:${
      isDueToday ? today : soonDate
    }`

    // A PAY-NOW LINK (R-046), minted per message so the reminder is
    // actionable from the text itself rather than sending somebody to an
    // email-only login they may not be able to pass.
    //
    // Only for a payer Stripe already knows: without a customer there is
    // nothing to pay against, and a link landing on "your payment account is
    // still being set up" is worse than no link. The message still goes —
    // "rent is due" is worth saying on its own.
    //
    // ISSUED BEFORE `notify`, and keyed to the LOGICAL send rather than a
    // row id, because `notify` fans out one row per channel and there is no
    // single Notification to point at. See `PayLinkSubject.notificationKey`.
    let url: string | null = null
    if (payer.stripeCustomerId) {
      try {
        const link = await issuePayLink({
          leasePayerId: payer.id,
          tenantId: payer.tenant.id,
          leaseId: payer.leaseId,
          notificationKey: idempotencyKey,
        })
        url = authUrl(`/pay/${link.token}`)
      } catch (error) {
        // Never fails the reminder. A tenant who does not get a link still
        // needs to know rent is due.
        console.error(`[due-notices] could not mint a pay link for ${payer.id}`, error)
      }
    }

    const outcomes = await notify({
      category: 'rent_reminder',
      templateKey: 'payment.due_soon',
      recipient: {
        type: 'TENANT',
        id: payer.tenant.id,
        email: payer.tenant.email,
        phone: payer.tenant.phone,
      },
      context: {
        tenantName: payer.tenant.firstName,
        addressLine1: property.addressLine1,
        amount: formatCents(payer.lease.rentCents),
        dueOn: isDueToday ? today : soonDate,
        isDueToday,
        url,
      },
      propertyId,
      // Keyed on WHICH notice, so a tenant due in three days who is still
      // due today three days later gets both, not one swallowed by the
      // other's key.
      idempotencyKey,
    })

    const deliveryIds = outcomes
      .map((outcome) => outcome.deliveryId)
      .filter((id): id is string => id != null)
    if (deliveryIds.length > 0) {
      // Flushed inline, like `predebit.ts` - a due-soon warning sitting in
      // an hourly queue has already spent part of its lead time.
      await dispatchPendingNotifications(new Date(), 50, { deliveryIds })
      if (isDueToday) dueTodaySent += 1
      else dueSoonSent += 1
    }
  }

  return { leasesChecked: payers.length, dueSoonSent, dueTodaySent }
}
