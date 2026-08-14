import 'server-only'

import { formatCents } from '@rental/core/money'
import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'

// The T-2 pre-debit notice (PAY-02, R-039a; D-3).
//
// AUTOPAY NOW MOVES MONEY AND NOTHING WARNS ANYBODY. That gap opened the
// moment enrolment started working: rent leaves a bank account without the
// tenant doing anything, and the difference between a working system and an
// angry phone call is whether they saw it coming. Two days is enough to move
// money in, or to ring the office before an overdraft rather than after one.
//
// ONLY FOR PAYERS WHO ARE ACTUALLY ON AUTOPAY - both halves, the same test
// the pay screen makes: `charge_automatically` AND a payment method on file.
// A payer on automatic collection with no method will not be debited; it
// will fail. Warning them of a debit that cannot happen is worse than
// silence, because the next notice they get is the one that says it failed.

export interface PredebitResult {
  leasesChecked: number
  noticesSent: number
}

/// Two days. The T in T-2.
const LEAD_DAYS = 2

/**
 * Warn every autopay payer at this property whose rent falls due in two
 * days, in the property's own local time.
 *
 * Idempotent on (payer, due date): the job runs daily and Stripe's retries
 * are not the only thing that can make it run twice, so the key is the fact
 * being announced rather than the attempt announcing it.
 */
export async function sendPredebitNotices(
  propertyId: string,
  now = new Date(),
): Promise<PredebitResult> {
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
    select: { timezone: true, addressLine1: true },
  })

  // The calendar day two days from now, PROPERTY-LOCAL (D-3). A portfolio
  // spanning three timezones has three different answers to "what is the
  // date in two days", and using the server's would warn a Texas tenant on
  // the wrong day.
  const target = new Date(now.getTime() + LEAD_DAYS * 86_400_000)
  const targetDate = businessDate(target, property.timezone)
  const dueDay = Number(targetDate.slice(8, 10))

  const payers = await prisma.leasePayer.findMany({
    where: {
      propertyId,
      active: true,
      // BOTH halves, as above.
      collectionMethod: 'charge_automatically',
      defaultPaymentMethodId: { not: null },
      // The payer's CHOSEN day when they have one, the lease's due day when
      // they do not (R-039a). Reading only the lease's day would warn a
      // tenant who moved their debit on the old schedule - a notice about a
      // debit that is not happening that day.
      OR: [
        { debitDay: dueDay },
        { debitDay: null, lease: { rentDueDay: dueDay } },
      ],
      lease: { status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
    },
    select: {
      id: true,
      leaseId: true,
      stripeAmountCents: true,
      tenant: { select: { id: true, firstName: true, email: true, phone: true } },
      lease: { select: { rentCents: true } },
    },
  })

  let noticesSent = 0

  for (const payer of payers) {
    if (!payer.tenant) continue

    // What we told Stripe to collect, falling back to the lease's rent when
    // the subscription amount was never recorded. Never a computed "expected
    // total": the invoice can carry a late fee added since, and a pre-debit
    // notice whose number is wrong teaches a tenant to ignore the next one.
    const amountCents = payer.stripeAmountCents ?? payer.lease.rentCents

    const outcomes = await notify({
      category: 'autopay_predebit',
      templateKey: 'autopay.predebit',
      recipient: {
        type: 'TENANT',
        id: payer.tenant.id,
        email: payer.tenant.email,
        phone: payer.tenant.phone,
      },
      context: {
        tenantName: payer.tenant.firstName,
        addressLine1: property.addressLine1,
        amount: formatCents(amountCents),
        debitOn: targetDate,
      },
      propertyId,
      // The FACT, not the attempt: this payer, this due date. A second run
      // on the same day sends nothing.
      idempotencyKey: `autopay-predebit:${payer.id}:${targetDate}`,
    })

    const deliveryIds = outcomes
      .map((outcome) => outcome.deliveryId)
      .filter((id): id is string => id != null)
    if (deliveryIds.length > 0) {
      // Flushed inline rather than left for the hourly sweep. A T-2 warning
      // that arrives on T-1 has spent a third of its usefulness waiting in a
      // queue.
      await dispatchPendingNotifications(new Date(), 50, { deliveryIds })
      noticesSent += 1
    }
  }

  return { leasesChecked: payers.length, noticesSent }
}
