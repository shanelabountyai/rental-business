import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRecurringCharge, deactivateRecurringCharge, syncRecurringCharges } from './recurring.ts'

// Pet rent and flat utility fees on the subscription (PAY-08, R-042).
//
// The rules about what may recur are unit-tested in
// packages/core/billing/recurring.test.ts. What is asserted here is the
// RECONCILER: that a charge reaches Stripe once, that it stops when it is
// supposed to, and - the one that makes `endsOn` more than decoration - that
// a charge whose end date has passed is taken off the subscription by a run
// that happens later.

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string

beforeAll(async () => {
  const stamp = `recurring-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '4 Pet Rent Row',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
  })
  unitId = unit.id
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Robin', lastName: `Recur-${randomUUID().slice(0, 6)}` },
  })
  tenantId = tenant.id
})

afterAll(async () => {
  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function seedLease(options: { withSubscription?: boolean } = {}) {
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01T00:00:00.000Z'),
      rentCents: 150_000,
      rentDueDay: 1,
    },
  })
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId } })
  await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId,
      payerType: 'TENANT',
      tenantId,
      stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      stripeSubscriptionId:
        options.withSubscription === false
          ? null
          : `sub_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    },
  })
  return lease
}

/// Yesterday and tomorrow, property-local, as `YYYY-MM-DD`. Written from a
/// real clock rather than pinned, because the whole point of the end-date
/// test is that it fires on a day nobody chose in advance.
function daysFromToday(offset: number): string {
  const now = new Date()
  return new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10)
}

describe('syncRecurringCharges', () => {
  it('puts an agreed charge on the subscription and records what it billed', async () => {
    const lease = await seedLease()
    const created = await createRecurringCharge({
      leaseId: lease.id,
      propertyId,
      type: 'PET_RENT',
      amountCents: 3_500,
      label: 'Two cats',
      startsOn: daysFromToday(-1),
    })

    const row = await prisma.recurringCharge.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.stripeSubscriptionItemId).not.toBeNull()
    expect(row.stripePriceId).not.toBeNull()
    // The tenant reads this line on every invoice from here on.
    expect(row.description).toBe('Pet rent — Two cats — $35.00/month')
  }, 20_000)

  it('adds the line ONCE however often the reconciler runs', async () => {
    // The sweep runs nightly and the lease page can trigger it. A second
    // subscription item is a tenant billed twice a month, for ever.
    const lease = await seedLease()
    const created = await createRecurringCharge({
      leaseId: lease.id,
      propertyId,
      type: 'PET_RENT',
      amountCents: 3_500,
      label: 'One dog',
      startsOn: daysFromToday(-1),
    })
    const first = await prisma.recurringCharge.findUniqueOrThrow({ where: { id: created.id } })

    const again = await syncRecurringCharges(lease.id)
    expect(again.added).toBe(0)

    const second = await prisma.recurringCharge.findUniqueOrThrow({ where: { id: created.id } })
    expect(second.stripeSubscriptionItemId).toBe(first.stripeSubscriptionItemId)
  }, 20_000)

  it('waits for a subscription rather than losing the charge', async () => {
    // Pet rent agreed on a draft lease has nowhere to go yet. It must not be
    // silently dropped - provisioning calls this once the subscription
    // exists.
    const lease = await seedLease({ withSubscription: false })
    const created = await createRecurringCharge({
      leaseId: lease.id,
      propertyId,
      type: 'UTILITY',
      amountCents: 2_500,
      label: 'Trash',
      startsOn: daysFromToday(-1),
    })

    const row = await prisma.recurringCharge.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.active).toBe(true)
    expect(row.stripeSubscriptionItemId).toBeNull()

    await prisma.leasePayer.updateMany({
      where: { leaseId: lease.id },
      data: { stripeSubscriptionId: `sub_${randomUUID().replace(/-/g, '').slice(0, 14)}` },
    })
    const result = await syncRecurringCharges(lease.id)
    expect(result.added).toBe(1)
  }, 20_000)

  it('does not bill a charge that has not started', async () => {
    const lease = await seedLease()
    const created = await createRecurringCharge({
      leaseId: lease.id,
      propertyId,
      type: 'PET_RENT',
      amountCents: 3_500,
      label: 'Puppy arriving next month',
      startsOn: daysFromToday(30),
    })

    const row = await prisma.recurringCharge.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.stripeSubscriptionItemId).toBeNull()
  }, 20_000)

  it('TAKES THE LINE OFF when its end date has passed', async () => {
    // The reason this reconciler exists rather than a push inside the add
    // action. A landlord who says the pet rent stops in March has said
    // something nothing else in the product would ever act on, and a fee that
    // outlives the pet is money taken from a tenant who agreed to no such
    // thing.
    const lease = await seedLease()
    const created = await createRecurringCharge({
      leaseId: lease.id,
      propertyId,
      type: 'PET_RENT',
      amountCents: 3_500,
      label: 'Cat, until the sublet ends',
      startsOn: daysFromToday(-30),
      endsOn: daysFromToday(30),
    })
    expect(
      (await prisma.recurringCharge.findUniqueOrThrow({ where: { id: created.id } }))
        .stripeSubscriptionItemId,
    ).not.toBeNull()

    // The end date arrives. Nothing else about the lease changes.
    await prisma.recurringCharge.update({
      where: { id: created.id },
      data: { endsOn: new Date(`${daysFromToday(-1)}T00:00:00.000Z`) },
    })
    const result = await syncRecurringCharges(lease.id)

    expect(result.ended).toBe(1)
    const row = await prisma.recurringCharge.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.stripeSubscriptionItemId).toBeNull()
    // Deactivated too, so the list a human reads says it is finished rather
    // than showing a live charge that bills nothing.
    expect(row.active).toBe(false)
  }, 20_000)

  it('bills THROUGH the day before the end date, not up to it', async () => {
    // Half-open, like the proration. A fee ending tomorrow still bills today;
    // getting this backwards drops a month of an agreed charge.
    const lease = await seedLease()
    const created = await createRecurringCharge({
      leaseId: lease.id,
      propertyId,
      type: 'UTILITY',
      amountCents: 2_000,
      label: 'Water, flat',
      startsOn: daysFromToday(-30),
      endsOn: daysFromToday(1),
    })

    const row = await prisma.recurringCharge.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.stripeSubscriptionItemId).not.toBeNull()
  }, 20_000)

  it('stops a charge on request and keeps the record of it', async () => {
    const lease = await seedLease()
    const created = await createRecurringCharge({
      leaseId: lease.id,
      propertyId,
      type: 'PET_RENT',
      amountCents: 4_000,
      label: 'Dog that moved out',
      startsOn: daysFromToday(-30),
    })

    await deactivateRecurringCharge(created.id)

    // Deactivated, NOT deleted. "Why was I charged $40 a month for two years"
    // is a question a deleted row cannot answer.
    const row = await prisma.recurringCharge.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.active).toBe(false)
    expect(row.stripeSubscriptionItemId).toBeNull()
    expect(row.description).toBe('Pet rent — Dog that moved out — $40.00/month')
  }, 20_000)

  it('does not try to end the same charge twice', async () => {
    // A dead subscription-item id left on the row would make every nightly
    // run attempt a delete and count a failure.
    const lease = await seedLease()
    const created = await createRecurringCharge({
      leaseId: lease.id,
      propertyId,
      type: 'PET_RENT',
      amountCents: 4_000,
      label: 'Gone',
      startsOn: daysFromToday(-30),
    })
    await deactivateRecurringCharge(created.id)

    const again = await syncRecurringCharges(lease.id)
    expect(again).toEqual({ added: 0, ended: 0, failed: 0 })
  }, 20_000)
})
