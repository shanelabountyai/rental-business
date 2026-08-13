import 'server-only'

import { billingCycleAnchor, moveInProration } from '@rental/core/billing'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { getBillingProvider } from '@/lib/billing/provider.ts'

// Charging the part month (PAY-08, R-042; D-12, D-3).
//
// R-036 provisioned the subscription, recorded `firstPeriodPartial`, and
// stopped - with a comment saying R-042 owns the amount "so a later item
// cannot silently skip it". This is that item, and the comment is the reason
// it was findable.
//
// D-12 KEEPS THE ARITHMETIC OURS. Stripe can prorate, and its proration is
// built for mid-cycle plan changes: it divides by the seconds in a billing
// period and answers "how much of this subscription did they consume". A
// move-in on a calendar rent asks something else - "how many days of this
// month did they live here" - and the lease answers it with a daily rate the
// tenant can check. The two agree by coincidence and disagree whenever a
// month is not 30 days, which is nine months in twelve.
//
// Structurally this is the third fee-push in the product and follows the same
// shape as the other two (`assessLateFees`, `assessNsfFee`): the Charge row
// is created FIRST so its id rides into Stripe's metadata and comes back on
// the invoice line, and a failed push leaves the Charge standing with a null
// `stripeInvoiceItemId` rather than leaving an invoice item in Stripe naming
// a charge that does not exist.

export interface ProrationChargeResult {
  chargeId: string | null
  amountCents: number
  reason: 'charged' | 'whole_month' | 'already_charged' | 'no_customer' | 'push_failed'
}

/**
 * Charge the partial first month, if there is one.
 *
 * Idempotent on the lease: provisioning can be retried and a resync can run
 * at any time, and a tenant billed twice for their first days is the worst
 * possible first impression of a new landlord's systems.
 */
export async function chargeMoveInProration(leaseId: string): Promise<ProrationChargeResult> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      rentCents: true,
      rentDueDay: true,
      startsOn: true,
      prorationMethod: true,
      property: { select: { timezone: true } },
      leasePayers: {
        select: { id: true, stripeCustomerId: true },
        take: 1,
      },
    },
  })

  // The anchor is the instant the first FULL period begins; the part month
  // runs from move-in up to it. Computed by the same function that told
  // Stripe when to bill, so the two cannot disagree about where the boundary
  // is (D-3: property-local, then expressed to Stripe).
  const anchor = billingCycleAnchor({
    rentDueDay: lease.rentDueDay,
    timezone: lease.property.timezone,
    // The lease's own start: the anchor is the first billing day on or after
    // it, which is exactly the boundary the part month runs up to.
    notBefore: lease.startsOn,
  })

  const proration = moveInProration({
    monthlyRentCents: lease.rentCents,
    // TWO DIFFERENT KINDS OF DATE, READ TWO DIFFERENT WAYS - the distinction
    // CLAUDE.md warns about and which cost this function an off-by-one day.
    //
    // `startsOn` is `@db.Date`: a CALENDAR DAY that Prisma hands back as UTC
    // midnight. Converting it through the property's zone moves it to the
    // previous day for anywhere west of UTC, which turned a 12-day March
    // proration into 13 and charged an extra day of rent.
    startsOn: utcToBusinessDate(lease.startsOn),
    // The anchor is a genuine INSTANT - the moment Stripe will bill - so it
    // does need the property's zone to name the local day it falls on.
    firstFullPeriodStartsOn: businessDate(anchor, lease.property.timezone),
    method: lease.prorationMethod === 'BANKER30' ? 'banker30' : 'actual',
  })

  // Null covers every legitimate no-charge case: the lease starts on the due
  // day, or the first period is not actually a part month. None of them is an
  // error and none should leave a zero-amount line on a tenant's first
  // invoice.
  if (!proration) return { chargeId: null, amountCents: 0, reason: 'whole_month' }

  const existing = await prisma.charge.findFirst({
    where: { leaseId, type: 'RENT', description: { startsWith: 'Part month' } },
    select: { id: true, amountCents: true },
  })
  if (existing) {
    return { chargeId: existing.id, amountCents: existing.amountCents, reason: 'already_charged' }
  }

  const payer = lease.leasePayers[0]
  if (!payer) return { chargeId: null, amountCents: 0, reason: 'no_customer' }

  const charge = await prisma.charge.create({
    data: {
      propertyId: lease.propertyId,
      leaseId: lease.id,
      // RENT, not a separate type. It IS rent - for fewer days than usual -
      // and typing it as something else would drop it out of every
      // rent-versus-fees split the product already makes.
      type: 'RENT',
      amountCents: proration.amountCents,
      // The arithmetic, in words, because PAY-08 requires the method to be
      // visible on the tenant's ledger. It is also the idempotency key above:
      // a description nobody would write by hand, so matching on it cannot
      // collide with an ordinary rent charge.
      description: proration.description,
      dueOn: lease.startsOn,
    },
  })

  if (!payer.stripeCustomerId) {
    return { chargeId: charge.id, amountCents: charge.amountCents, reason: 'no_customer' }
  }

  try {
    const item = await getBillingProvider().addInvoiceItem({
      stripeCustomerId: payer.stripeCustomerId,
      amountCents: proration.amountCents,
      currency: 'usd',
      description: proration.description,
      chargeId: charge.id,
      // Keyed on the lease, because there is exactly one move-in per lease.
      idempotencyKey: `proration:${lease.id}`,
    })
    await prisma.charge.update({
      where: { id: charge.id },
      data: { stripeInvoiceItemId: item.stripeInvoiceItemId },
    })
  } catch (error) {
    console.error(`[proration] failed to push charge ${charge.id}`, error)
    return { chargeId: charge.id, amountCents: charge.amountCents, reason: 'push_failed' }
  }

  await auditAsSystem('billing.proration', {
    action: 'ledger.adjusted',
    entityType: 'Charge',
    entityId: charge.id,
    propertyId: lease.propertyId,
    after: {
      type: 'RENT',
      partMonth: true,
      amountCents: proration.amountCents,
      daysOccupied: proration.daysOccupied,
      daysInMonth: proration.daysInMonth,
      method: proration.method,
      monthlyRentCents: lease.rentCents,
    },
  }).catch((error: unknown) => {
    console.error(`[proration] failed to audit charge ${charge.id}`, error)
  })

  return { chargeId: charge.id, amountCents: charge.amountCents, reason: 'charged' }
}
