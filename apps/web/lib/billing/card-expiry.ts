import 'server-only'

import { businessDate, businessDaysBetween } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { authUrl } from '@/lib/auth/delivery.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'
import { dispatchPendingNotifications, notify } from '@/lib/notifications/send.ts'

// "Your card on file is expiring" (PAY-02, R-045).
//
// ==========================================================================
// THE WHOLE REASON THIS ROW IS IN THE BACKLOG: A LONG-TENURED, ALWAYS-ON-TIME
// TENANT MUST NEVER SEE `payment.failed_fix`.
//
// Without this, a card silently expiring is indistinguishable from a tenant
// who stopped paying - the autopay charge fails, `payment.failed_fix` fires,
// and somebody who has paid on time for three years gets the same message as
// somebody who has not. This runs while there is still a month to act,
// instead of after the first failed charge.
//
// READ FROM THE PROVIDER, NEVER STORED. `paymentMethodExpiry` is the seam
// (adapter.ts's own comment explains why: card metadata belongs to Stripe,
// not to a second copy in this schema that can go stale or leak).
// ==========================================================================

export interface CardExpiryResult {
  payersChecked: number
  noticesSent: number
}

/// A month. Enough time to replace a card before the next debit, not so much
/// that the warning arrives too far ahead to act on.
const WARN_WITHIN_DAYS = 30

export async function sendCardExpiringNotices(
  propertyId: string,
  now = new Date(),
): Promise<CardExpiryResult> {
  const property = await prisma.property.findUniqueOrThrow({
    where: { id: propertyId },
    select: { timezone: true, addressLine1: true },
  })

  const payers = await prisma.leasePayer.findMany({
    where: {
      propertyId,
      active: true,
      collectionMethod: 'charge_automatically',
      defaultPaymentMethodId: { not: null },
      lease: { status: { in: ['ACTIVE', 'MONTH_TO_MONTH'] } },
    },
    select: {
      id: true,
      defaultPaymentMethodId: true,
      tenant: { select: { id: true, firstName: true, email: true, phone: true } },
    },
  })

  const provider = getBillingProvider()
  const today = businessDate(now, property.timezone)
  let noticesSent = 0

  for (const payer of payers) {
    if (!payer.tenant || !payer.defaultPaymentMethodId) continue

    // NULL FOR A BANK-DEBIT METHOD, which has no expiry - see the provider's
    // own doc-comment. Nothing to warn about, and not an error.
    const expiry = await provider.paymentMethodExpiry(payer.defaultPaymentMethodId)
    if (!expiry) continue

    // The FIRST day of the expiry month, not the last - "expires 12/2026"
    // means the card stops working sometime that month, and warning from
    // the first day of it is the conservative reading.
    const expiresOn = `${expiry.expYear}-${String(expiry.expMonth).padStart(2, '0')}-01`
    const daysUntilExpiry = businessDaysBetween(today, expiresOn)
    if (daysUntilExpiry < 0 || daysUntilExpiry > WARN_WITHIN_DAYS) continue

    const outcomes = await notify({
      category: 'rent_reminder',
      templateKey: 'payment.card_expiring',
      recipient: {
        type: 'TENANT',
        id: payer.tenant.id,
        email: payer.tenant.email,
        phone: payer.tenant.phone,
      },
      context: {
        tenantName: payer.tenant.firstName,
        addressLine1: property.addressLine1,
        expiresOn: `${expiry.expMonth}/${expiry.expYear}`,
        url: authUrl('/portal/pay'),
      },
      propertyId,
      // Keyed on the CARD'S OWN EXPIRY, not on today's date. The scan runs
      // every night for up to thirty days before the same card expires, and
      // keying on today would send thirty separate warnings for one card -
      // worse than the silence this item exists to fix.
      idempotencyKey: `card-expiring:${payer.id}:${expiry.expYear}-${expiry.expMonth}`,
    })

    const deliveryIds = outcomes
      .map((outcome) => outcome.deliveryId)
      .filter((id): id is string => id != null)
    if (deliveryIds.length > 0) {
      await dispatchPendingNotifications(new Date(), 50, { deliveryIds })
      noticesSent += 1
    }
  }

  return { payersChecked: payers.length, noticesSent }
}

