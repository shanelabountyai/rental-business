import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sendDueNotices } from './due-notices.ts'

// Due-soon (T-3) and due-date reminders (PAY-02, R-045).
//
// The assertion that matters most: this must never warn a tenant who is
// already covered by `autopay.predebit`. Sending both tells an autopay
// tenant to go pay rent the product is about to collect automatically.

let entityId: string
let propertyId: string
let unitId: string
const tenantIds: string[] = []
const leaseIds: string[] = []

beforeAll(async () => {
  const stamp = `duenotice-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '22 Due Date Drive',
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

async function seedPayer(args: {
  rentDueDay: number
  collectionMethod: 'charge_automatically' | 'send_invoice'
  hasMethod: boolean
}) {
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Robin',
      lastName: `DueNotice-${randomUUID().slice(0, 6)}`,
      email: `duenotice-${randomUUID().slice(0, 8)}@example.test`,
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

function dayOfMonth(date: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', day: '2-digit' }).format(
      date,
    ),
  )
}

describe('sendDueNotices', () => {
  const now = new Date('2026-05-10T15:00:00Z')
  const todayDay = dayOfMonth(now)
  const soonDay = dayOfMonth(new Date(now.getTime() + 3 * 86_400_000))

  it('warns a payer whose rent is due TODAY', async () => {
    const { tenant } = await seedPayer({
      rentDueDay: todayDay,
      collectionMethod: 'send_invoice',
      hasMethod: false,
    })

    await sendDueNotices(propertyId, now)
    const notices = await prisma.notification.findMany({
      where: { recipientId: tenant.id, templateKey: 'payment.due_soon' },
    })
    expect(notices.length).toBeGreaterThan(0)
    expect(notices.some((n) => n.body.includes('due today'))).toBe(true)
  }, 30_000)

  it('warns a payer whose rent is due in THREE DAYS', async () => {
    const { tenant } = await seedPayer({
      rentDueDay: soonDay,
      collectionMethod: 'send_invoice',
      hasMethod: false,
    })

    await sendDueNotices(propertyId, now)
    const notices = await prisma.notification.findMany({
      where: { recipientId: tenant.id, templateKey: 'payment.due_soon' },
    })
    expect(notices.length).toBeGreaterThan(0)
    expect(notices.some((n) => n.body.includes('is due') && !n.body.includes('due today'))).toBe(
      true,
    )
  }, 30_000)

  it('DOES NOT WARN A PAYER ALREADY COVERED BY autopay.predebit', async () => {
    // On automatic collection WITH a method - genuinely autopay. Sending
    // this too tells them to go pay rent the product is about to collect.
    const { tenant } = await seedPayer({
      rentDueDay: todayDay,
      collectionMethod: 'charge_automatically',
      hasMethod: true,
    })

    await sendDueNotices(propertyId, now)
    expect(
      await prisma.notification.count({
        where: { recipientId: tenant.id, templateKey: 'payment.due_soon' },
      }),
    ).toBe(0)
  }, 30_000)

  it('DOES WARN AN AUTOPAY TENANT WITH NO METHOD ON FILE', async () => {
    // Marked charge_automatically but nothing will actually be collected -
    // predebit.ts skips them for the same reason, and this is the tenant who
    // most needs to hear "you have to do this yourself".
    const { tenant } = await seedPayer({
      rentDueDay: todayDay,
      collectionMethod: 'charge_automatically',
      hasMethod: false,
    })

    await sendDueNotices(propertyId, now)
    expect(
      await prisma.notification.count({
        where: { recipientId: tenant.id, templateKey: 'payment.due_soon' },
      }),
    ).toBeGreaterThan(0)
  }, 30_000)

  it('does NOT warn a payer whose rent is due on a different day', async () => {
    const otherDay = todayDay === 28 ? 1 : todayDay + 1
    const { tenant } = await seedPayer({
      rentDueDay: otherDay === soonDay ? (otherDay === 28 ? 2 : otherDay + 1) : otherDay,
      collectionMethod: 'send_invoice',
      hasMethod: false,
    })

    await sendDueNotices(propertyId, now)
    expect(
      await prisma.notification.count({
        where: { recipientId: tenant.id, templateKey: 'payment.due_soon' },
      }),
    ).toBe(0)
  }, 30_000)

  it('warns ONCE however many times the job runs that day', async () => {
    const { tenant } = await seedPayer({
      rentDueDay: todayDay,
      collectionMethod: 'send_invoice',
      hasMethod: false,
    })

    await sendDueNotices(propertyId, now)
    const after = await prisma.notification.count({
      where: { recipientId: tenant.id, templateKey: 'payment.due_soon' },
    })
    await sendDueNotices(propertyId, now)

    expect(
      await prisma.notification.count({
        where: { recipientId: tenant.id, templateKey: 'payment.due_soon' },
      }),
    ).toBe(after)
  }, 30_000)
})
