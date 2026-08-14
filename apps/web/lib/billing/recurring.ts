import 'server-only'

import { describeRecurringCharge, isRecurringChargeType } from '@rental/core/billing'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { getBillingProvider } from './provider.ts'

// Pet rent and flat utility fees on the subscription (PAY-08, R-042).
//
// `RecurringCharge` has been in the schema since R-002, with `stripePriceId`
// and `stripeSubscriptionItemId` columns and NO CODE ANYWHERE. This is what
// fills them.
//
// ONE RECONCILER, NOT THREE WRITERS. Adding a charge, ending one, and the
// nightly sweep all call the same function, which asks a single question per
// row - should Stripe be billing this today? - and makes Stripe agree. The
// alternative, a push inside the add action and a separate removal inside the
// end action, has three places that can each leave our row and Stripe
// disagreeing, and the disagreement is money.
//
// That shape is what makes `endsOn` real. A landlord who sets an end date has
// said the fee stops then; without something that runs later, the column
// would be decoration and the tenant would go on paying pet rent for a dog
// that moved out. The nightly billing sweep already exists as the safety net
// for a failed lifecycle sync, and this rides on it.
//
// WHICH SUBSCRIPTION. The first active payer's, which is the same rule
// `chargeMoveInProration` uses for invoice items. A voucher lease runs two
// payers and two subscriptions (D-13), and deciding that a housing authority
// should be billed for a cat is R-048's to make deliberately, not this
// item's to guess.

export interface RecurringSyncResult {
  added: number
  ended: number
  failed: number
}

/**
 * Makes the subscription bill exactly the recurring charges that are live
 * today.
 *
 * Idempotent, and safe to call on a lease with no subscription yet: a charge
 * agreed before billing was provisioned simply waits, and provisioning calls
 * this once the subscription exists.
 */
export async function syncRecurringCharges(leaseId: string): Promise<RecurringSyncResult> {
  const lease = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      property: { select: { timezone: true } },
      recurringCharges: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          type: true,
          amountCents: true,
          description: true,
          startsOn: true,
          endsOn: true,
          active: true,
          stripeSubscriptionItemId: true,
        },
      },
      leasePayers: {
        where: { active: true },
        orderBy: { createdAt: 'asc' },
        take: 1,
        select: { id: true, stripeSubscriptionId: true },
      },
    },
  })
  if (!lease) return { added: 0, ended: 0, failed: 0 }

  // PROPERTY-LOCAL (D-3). A fee ending on the 31st ends when it is the 31st
  // where the house is, not where the server is.
  const today = businessDate(new Date(), lease.property.timezone)
  const subscriptionId = lease.leasePayers[0]?.stripeSubscriptionId ?? null

  const result: RecurringSyncResult = { added: 0, ended: 0, failed: 0 }

  for (const charge of lease.recurringCharges) {
    // `startsOn` and `endsOn` are `@db.Date` - calendar days that Prisma
    // hands back as UTC midnight. `utcToBusinessDate`, never `businessDate`:
    // converting a calendar day THROUGH a zone moves it a day west of UTC,
    // which is the bug that cost R-042 an extra day of rent on every move-in.
    const startsOn = utcToBusinessDate(charge.startsOn)
    const endsOn = charge.endsOn ? utcToBusinessDate(charge.endsOn) : null

    // Half-open, like the proration: the end date is the first day NOT
    // covered. A fee ending on 1 September bills through August.
    const shouldBill =
      charge.active && startsOn <= today && (endsOn === null || today < endsOn)

    if (shouldBill && !charge.stripeSubscriptionItemId) {
      if (!subscriptionId) continue
      try {
        const item = await getBillingProvider().addSubscriptionItem({
          stripeSubscriptionId: subscriptionId,
          amountCents: charge.amountCents,
          currency: 'usd',
          description: charge.description,
          recurringChargeId: charge.id,
          leaseId: lease.id,
          // Keyed on the FACT - this agreed charge - so a retry after a
          // timeout adds the line once rather than billing the tenant twice
          // every month for the rest of the tenancy.
          idempotencyKey: `recurring:${charge.id}`,
        })
        await prisma.recurringCharge.update({
          where: { id: charge.id },
          data: {
            stripePriceId: item.stripePriceId,
            stripeSubscriptionItemId: item.stripeSubscriptionItemId,
          },
        })
        result.added += 1
        await auditRecurring(lease.propertyId, charge.id, 'billing.recurring_started', {
          type: charge.type,
          amountCents: charge.amountCents,
          description: charge.description,
          stripeSubscriptionItemId: item.stripeSubscriptionItemId,
        })
      } catch (error) {
        result.failed += 1
        console.error(`[recurring] could not add charge ${charge.id} to ${subscriptionId}`, error)
      }
      continue
    }

    if (!shouldBill && charge.stripeSubscriptionItemId) {
      try {
        await getBillingProvider().endSubscriptionItem({
          stripeSubscriptionItemId: charge.stripeSubscriptionItemId,
        })
        await prisma.recurringCharge.update({
          where: { id: charge.id },
          data: {
            // Cleared because it no longer names anything at Stripe. Leaving
            // a dead id here would make every later run try to delete it
            // again and count a failure each night.
            stripeSubscriptionItemId: null,
            // A charge that ran past its own end date is finished, and saying
            // so keeps the list a human reads honest. Deactivating in our row
            // AND at Stripe is one fact recorded twice on purpose.
            active: endsOn !== null && today >= endsOn ? false : charge.active,
          },
        })
        result.ended += 1
        await auditRecurring(lease.propertyId, charge.id, 'billing.recurring_ended', {
          type: charge.type,
          amountCents: charge.amountCents,
          endsOn,
          reason: charge.active ? 'reached its end date' : 'ended by staff',
        })
      } catch (error) {
        result.failed += 1
        console.error(`[recurring] could not end charge ${charge.id}`, error)
      }
    }
  }

  return result
}

/// Never throws into the caller, for the reason every audit call in the
/// billing package gives: the money already moved, and losing the record of
/// it is bad but undoing it is worse.
async function auditRecurring(
  propertyId: string,
  recurringChargeId: string,
  action: 'billing.recurring_started' | 'billing.recurring_ended',
  after: Record<string, unknown>,
): Promise<void> {
  await auditAsSystem('billing.recurring', {
    action,
    entityType: 'RecurringCharge',
    entityId: recurringChargeId,
    propertyId,
    after,
  }).catch((error: unknown) => {
    console.error(`[recurring] failed to audit ${recurringChargeId}`, error)
  })
}

/// What the lease page shows. Reads our own rows, like every other billing
/// screen - a network call per line would be slow and would disagree with the
/// projection.
export async function recurringChargesForLease(leaseId: string) {
  return prisma.recurringCharge.findMany({
    where: { leaseId },
    orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      type: true,
      amountCents: true,
      description: true,
      startsOn: true,
      endsOn: true,
      active: true,
      stripeSubscriptionItemId: true,
    },
  })
}

export interface CreateRecurringChargeInput {
  leaseId: string
  propertyId: string
  type: string
  amountCents: number
  label: string
  startsOn: string
  endsOn?: string | null
}

/**
 * Writes the agreed charge and pushes it, in that order.
 *
 * The row goes in FIRST, like every other push in this product: a failed
 * push leaves a charge standing with a null `stripeSubscriptionItemId` for
 * the next sync to retry, rather than leaving a line billing at Stripe that
 * nothing in our records explains.
 */
export async function createRecurringCharge(input: CreateRecurringChargeInput) {
  if (!isRecurringChargeType(input.type)) {
    throw new Error(`not a recurring charge type: ${input.type}`)
  }
  const created = await prisma.recurringCharge.create({
    data: {
      propertyId: input.propertyId,
      leaseId: input.leaseId,
      type: input.type,
      amountCents: input.amountCents,
      description: describeRecurringCharge({
        type: input.type,
        amountCents: input.amountCents,
        label: input.label,
      }),
      startsOn: new Date(`${input.startsOn}T00:00:00.000Z`),
      endsOn: input.endsOn ? new Date(`${input.endsOn}T00:00:00.000Z`) : null,
      // R-002 gave this column a default of 1. It is not used: Stripe bills
      // subscription items on the subscription's own anchor, which is the
      // lease's rent due day, and a second day of month here would be a
      // schedule nothing reads.
      dayOfMonth: 1,
    },
  })
  await syncRecurringCharges(input.leaseId)
  return created
}

/**
 * Stops a recurring charge now.
 *
 * Deactivates rather than deleting. `RecurringCharge` is not append-only, but
 * what was agreed and when it stopped is the answer to "why was I charged
 * $35 a month for two years", and a deleted row answers nothing.
 */
export async function deactivateRecurringCharge(id: string): Promise<void> {
  const charge = await prisma.recurringCharge.update({
    where: { id },
    data: { active: false },
    select: { leaseId: true },
  })
  await syncRecurringCharges(charge.leaseId)
}
