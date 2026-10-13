import 'server-only'

import { billingCycleAnchor, moveInProration, moveOutProration } from '@rental/core/billing'
import { businessDate, businessDateToUtc, utcToBusinessDate } from '@rental/core/scheduling'
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
export async function chargeMoveInProration(
  leaseId: string,
  /// The instant the subscription first bills - `firstBillingAnchor`, the
  /// SAME value `provisionLeaseBilling` handed to Stripe. Passed in rather
  /// than derived here, because deriving it here from the lease's start
  /// alone is how the part month and the subscription came to disagree about
  /// where the boundary is (D-301).
  anchor: Date,
): Promise<ProrationChargeResult> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      rentCents: true,
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
  // runs from move-in up to it.
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

  // Null covers every legitimate no-charge case: the subscription bills the
  // lease's first day itself, or the gap before it first bills is longer
  // than a month (an inherited tenancy activated long after it began - not a
  // part month, and not ours to back-bill). None of them is an error and
  // none should leave a zero-amount line on a tenant's first invoice.
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
    // `ledger.adjusted` is on REASON_REQUIRED, and this call carried no
    // reason - so `recordAudit` threw, the `.catch` below logged it, and
    // EVERY move-in proration ever charged has no audit entry at all. The
    // charge is on the tenant's ledger and nothing records who put it there
    // or why, which is the one thing that set exists to prevent. Found by
    // the Milestone 10 demo walk, four rows deep in a seed log.
    //
    // `proration.description` is the arithmetic in words - the same sentence
    // PAY-08 puts on the tenant's own ledger - so the audit reason and what
    // the tenant was told cannot drift apart.
    reason: proration.description,
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

export interface MoveOutProrationChargeResult {
  chargeId: string | null
  amountCents: number
  reason: 'credited' | 'no_credit' | 'already_credited' | 'no_customer' | 'no_move_out'
}

/**
 * Credit the unoccupied tail of the final month, if there is one (R-160).
 *
 * `chargeMoveInProration`'s mirror, same idempotency posture: re-running a
 * status transition — or a nightly resync — must not credit a tenant twice.
 * `Charge.amountCents` is negative here, the one place in the product a
 * charge reduces rather than increases what's owed.
 *
 * A LEDGER-ONLY CREDIT, AND THE ONE ROW IN `LedgerEntry` THE WEBHOOK DID NOT
 * WRITE (D-302, the owner's call; amends D-11 and D-165 for this case alone).
 * It used to be a negative invoice item, which rides the payer's NEXT
 * invoice - and a tenancy that has ended never has one, so the credit never
 * finalized, never projected, and the deposit disposition read a balance
 * that still charged the tenant for days they were gone. Nothing at Stripe
 * can carry it without a credit note, so nothing is sent: the entry has no
 * `stripeEventId`, and `reconcileLedger` leaves it out of what it expects
 * Stripe to agree with.
 */
export async function chargeMoveOutProration(leaseId: string): Promise<MoveOutProrationChargeResult> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      rentCents: true,
      rentDueDay: true,
      moveOutAt: true,
      prorationMethod: true,
      property: { select: { timezone: true } },
      leasePayers: {
        select: { id: true, stripeCustomerId: true },
        take: 1,
      },
    },
  })

  if (!lease.moveOutAt) return { chargeId: null, amountCents: 0, reason: 'no_move_out' }

  const moveOutOn = businessDate(lease.moveOutAt, lease.property.timezone)

  // The boundary of the period already billed in advance: the next due day
  // on or after move-out. Same function that told Stripe when to bill, so
  // this cannot disagree with it about where the period ends.
  const anchor = billingCycleAnchor({
    rentDueDay: lease.rentDueDay,
    timezone: lease.property.timezone,
    notBefore: lease.moveOutAt,
  })

  const proration = moveOutProration({
    monthlyRentCents: lease.rentCents,
    moveOutOn,
    currentPeriodEndsOn: businessDate(anchor, lease.property.timezone),
    method: lease.prorationMethod === 'BANKER30' ? 'banker30' : 'actual',
  })

  // Null covers moving out exactly on the next due day — the period already
  // billed is the one fully occupied, so there is nothing to give back.
  if (!proration) return { chargeId: null, amountCents: 0, reason: 'no_credit' }

  // A payer nothing was ever billed to has no period paid in advance to give
  // part of back. This was harmless while the credit could not land; now
  // that it does, crediting rent never charged would be money invented.
  const payer = lease.leasePayers[0]
  if (!payer?.stripeCustomerId) return { chargeId: null, amountCents: 0, reason: 'no_customer' }

  const posted = await prisma.$transaction(async (tx) => {
    // THE LOCK IS THE IDEMPOTENCY, since no unique index names "the move-out
    // credit" and a read-then-write alone lets two runs both pass the read.
    // The same per-lease lock a settling payment plans its allocation under
    // (MONEY-16), so that plan never sees half of this either.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lease-allocation:${lease.id}`}))`

    const existing = await tx.charge.findFirst({
      where: { leaseId, type: 'RENT', description: { startsWith: 'Move-out credit' } },
      select: { id: true, amountCents: true },
    })
    // Including a credit written before D-302, which has a Charge and no
    // entry. Nothing is backfilled (D-201): its disposition may already have
    // gone out on the old balance.
    if (existing) return { charge: existing, created: false }

    const charge = await tx.charge.create({
      data: {
        propertyId: lease.propertyId,
        leaseId: lease.id,
        // RENT, not a separate type — it's a reduction of rent already billed,
        // and typing it as something else would drop it out of every
        // rent-versus-fees split the product already makes.
        type: 'RENT',
        amountCents: -proration.amountCents,
        description: proration.description,
        dueOn: businessDateToUtc(moveOutOn),
      },
      select: { id: true, amountCents: true },
    })
    // Charge and entry commit together or not at all, so "is there a Charge"
    // above is the same question as "has the credit been posted".
    await tx.ledgerEntry.create({
      data: {
        propertyId: lease.propertyId,
        leaseId: lease.id,
        leasePayerId: payer.id,
        chargeId: charge.id,
        type: 'CREDIT',
        amountCents: -proration.amountCents,
        // The arithmetic in words, as on the Charge: it is what the tenant
        // reads on their statement and what the disposition letter cites.
        description: proration.description,
        // When it was posted. Not back-dated to the move-out: an entry
        // slipped into the past would change running balances already
        // printed on a statement.
        occurredAt: new Date(),
      },
    })
    // In the transaction, unlike the move-in audit: this row has no Stripe
    // event behind it, so the audit entry is the only record of where it
    // came from and the two must not be separable.
    await auditAsSystem(
      'billing.proration',
      {
        action: 'ledger.adjusted',
        entityType: 'Charge',
        entityId: charge.id,
        propertyId: lease.propertyId,
        reason: proration.description,
        after: {
          type: 'RENT',
          moveOutCredit: true,
          ledgerOnly: true,
          amountCents: -proration.amountCents,
          daysVacant: proration.daysOccupied,
          daysInMonth: proration.daysInMonth,
          method: proration.method,
          monthlyRentCents: lease.rentCents,
        },
      },
      tx,
    )
    return { charge, created: true }
  })

  return {
    chargeId: posted.charge.id,
    amountCents: posted.charge.amountCents,
    reason: posted.created ? 'credited' : 'already_credited',
  }
}
