import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sendPredebitNotices } from './predebit.ts'

// The T-2 pre-debit notice (PAY-02, R-039a).
//
// The gap this closes opened the moment autopay started working: money now
// leaves a bank account without the tenant doing anything, and nothing warned
// them. The assertions worth making are about WHO gets warned - warning
// somebody whose debit cannot happen is worse than silence.

let entityId: string
let propertyId: string
let unitId: string
const tenantIds: string[] = []
const leaseIds: string[] = []

beforeAll(async () => {
  const stamp = `predebit-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '11 Notice Lane',
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
})

afterAll(async () => {
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

/** A payer due on `rentDueDay`, in whichever autopay state is being tested. */
async function seedPayer(args: {
  rentDueDay: number
  collectionMethod: 'charge_automatically' | 'send_invoice'
  hasMethod: boolean
}) {
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Dana',
      lastName: `Predebit-${randomUUID().slice(0, 6)}`,
      email: `predebit-${randomUUID().slice(0, 8)}@example.test`,
    },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
      rentDueDay: args.rentDueDay,
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
  await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId,
      payerType: 'TENANT',
      tenantId: tenant.id,
      collectionMethod: args.collectionMethod,
      defaultPaymentMethodId: args.hasMethod ? `pm_${randomUUID().slice(0, 10)}` : null,
      stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      stripeAmountCents: 150_000,
    },
  })
  return { tenant, lease }
}

/// Two days from `now`, in the property's zone - the day a payer must be due
/// on to be warned today.
function dueDayTwoDaysFrom(now: Date): number {
  const target = new Date(now.getTime() + 2 * 86_400_000)
  return Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', day: '2-digit' }).format(
      target,
    ),
  )
}

describe('sendPredebitNotices', () => {
  const now = new Date('2026-05-10T15:00:00Z')
  const dueDay = dueDayTwoDaysFrom(now)

  it('warns a payer who is genuinely on autopay', async () => {
    const { tenant } = await seedPayer({
      rentDueDay: dueDay,
      collectionMethod: 'charge_automatically',
      hasMethod: true,
    })

    const result = await sendPredebitNotices(propertyId, now)
    expect(result.noticesSent).toBeGreaterThan(0)

    const notices = await prisma.notification.findMany({
      where: { recipientId: tenant.id, category: 'autopay_predebit' },
    })
    expect(notices.length).toBeGreaterThan(0)
    // The amount is the recurring one we told Stripe to collect, not a
    // predicted invoice total.
    expect(notices.some((n) => n.body.includes('$1,500.00'))).toBe(true)
  }, 30_000)

  it('does NOT warn a payer with no payment method on file', async () => {
    // They are on automatic collection but nothing will be debited - the
    // invoice will fail. Warning them of a debit that cannot happen is worse
    // than silence: the next message they get says it failed.
    const { tenant } = await seedPayer({
      rentDueDay: dueDay,
      collectionMethod: 'charge_automatically',
      hasMethod: false,
    })

    await sendPredebitNotices(propertyId, now)
    expect(
      await prisma.notification.count({
        where: { recipientId: tenant.id, category: 'autopay_predebit' },
      }),
    ).toBe(0)
  }, 30_000)

  it('does NOT warn a payer who is invoiced rather than debited', async () => {
    // Nothing is taken automatically, so there is nothing to warn about.
    const { tenant } = await seedPayer({
      rentDueDay: dueDay,
      collectionMethod: 'send_invoice',
      hasMethod: true,
    })

    await sendPredebitNotices(propertyId, now)
    expect(
      await prisma.notification.count({
        where: { recipientId: tenant.id, category: 'autopay_predebit' },
      }),
    ).toBe(0)
  }, 30_000)

  it('does NOT warn somebody whose rent is due on a different day', async () => {
    const { tenant } = await seedPayer({
      rentDueDay: dueDay === 28 ? 1 : dueDay + 1,
      collectionMethod: 'charge_automatically',
      hasMethod: true,
    })

    await sendPredebitNotices(propertyId, now)
    expect(
      await prisma.notification.count({
        where: { recipientId: tenant.id, category: 'autopay_predebit' },
      }),
    ).toBe(0)
  }, 30_000)

  it('warns on the payer CHOSEN day, not the lease due day', async () => {
    // A tenant who moved their debit to day 3 must be warned two days before
    // DAY 3. Reading only the lease's due day would warn them about a debit
    // that is not happening that day (R-039a).
    const { tenant } = await seedPayer({
      // Due on a day that is NOT the target, so only the chosen day can match.
      rentDueDay: dueDay === 28 ? 1 : dueDay + 1,
      collectionMethod: 'charge_automatically',
      hasMethod: true,
    })
    await prisma.leasePayer.updateMany({
      where: { tenantId: tenant.id },
      data: { debitDay: dueDay },
    })

    await sendPredebitNotices(propertyId, now)
    expect(
      await prisma.notification.count({
        where: { recipientId: tenant.id, category: 'autopay_predebit' },
      }),
    ).toBeGreaterThan(0)
  }, 30_000)

  it('does NOT warn on the lease day once the payer has chosen another', async () => {
    // The other half: their old day must go quiet, or they get two warnings a
    // month and learn to ignore both.
    const { tenant } = await seedPayer({
      rentDueDay: dueDay,
      collectionMethod: 'charge_automatically',
      hasMethod: true,
    })
    await prisma.leasePayer.updateMany({
      where: { tenantId: tenant.id },
      data: { debitDay: dueDay === 28 ? 1 : dueDay + 1 },
    })

    await sendPredebitNotices(propertyId, now)
    expect(
      await prisma.notification.count({
        where: { recipientId: tenant.id, category: 'autopay_predebit' },
      }),
    ).toBe(0)
  }, 30_000)

  it('warns ONCE however many times the job runs that day', async () => {
    // The job is daily and nothing stops it running twice. The idempotency
    // key is the fact being announced - this payer, this due date - not the
    // attempt announcing it.
    const { tenant } = await seedPayer({
      rentDueDay: dueDay,
      collectionMethod: 'charge_automatically',
      hasMethod: true,
    })

    await sendPredebitNotices(propertyId, now)
    const after = await prisma.notification.count({
      where: { recipientId: tenant.id, category: 'autopay_predebit' },
    })
    await sendPredebitNotices(propertyId, now)

    expect(
      await prisma.notification.count({
        where: { recipientId: tenant.id, category: 'autopay_predebit' },
      }),
    ).toBe(after)
  }, 30_000)
})
