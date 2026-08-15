import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sendCardExpiringNotices } from './card-expiry.ts'
import { simulatedCardExpiry } from './simulated-adapter.ts'

// "Your card on file is expiring" (PAY-02, R-045).
//
// The assertion that matters most: a card far from expiring must stay
// silent, and a card within the window must warn - proven against the
// SIMULATOR's own independent oracle (D-27), not against a value this test
// derived the same way the decision does.

let entityId: string
let propertyId: string
let unitId: string
const tenantIds: string[] = []
const leaseIds: string[] = []

beforeAll(async () => {
  const stamp = `cardexpiry-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '5 Card Expiry Court',
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

async function seedPayer(args: { defaultPaymentMethodId: string | null }) {
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Sasha',
      lastName: `CardExpiry-${randomUUID().slice(0, 6)}`,
      email: `cardexpiry-${randomUUID().slice(0, 8)}@example.test`,
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
      collectionMethod: 'charge_automatically',
      defaultPaymentMethodId: args.defaultPaymentMethodId,
      stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    },
  })
  return { tenant, lease }
}

/// A `pm_` id whose SIMULATOR-COMPUTED expiry is `withinDaysOfNow` days from
/// `now`, and the `now` to pair it with — derived from the id's own answer,
/// never the other way around. Deriving `now` from a fixed id (rather than
/// searching for an id that fits a fixed `now`) is what keeps this test
/// independent of the hash's exact distribution: it works for any id.
function expiryFixture(id: string, now: Date, withinDaysOfNow: number) {
  const expiry = simulatedCardExpiry(id)
  const expiresOn = new Date(Date.UTC(expiry.expYear, expiry.expMonth - 1, 1))
  const target = new Date(expiresOn.getTime() - withinDaysOfNow * 86_400_000)
  return target
}

describe('sendCardExpiringNotices', () => {
  it('WARNS when the card expires within thirty days', async () => {
    const id = `pm_${randomUUID().slice(0, 10)}`
    const now = expiryFixture(id, new Date(), 10) // 10 days before its expiry month
    const { tenant } = await seedPayer({ defaultPaymentMethodId: id })

    await sendCardExpiringNotices(propertyId, now)
    const notices = await prisma.notification.findMany({
      where: { recipientId: tenant.id, templateKey: 'payment.card_expiring' },
    })
    expect(notices.length).toBeGreaterThan(0)
    const expiry = simulatedCardExpiry(id)
    expect(notices[0].body).toContain(`${expiry.expMonth}/${expiry.expYear}`)
  }, 30_000)

  it('STAYS SILENT when the card expires far in the future', async () => {
    const id = `pm_${randomUUID().slice(0, 10)}`
    const now = expiryFixture(id, new Date(), 200) // 200 days out — well past the window
    const { tenant } = await seedPayer({ defaultPaymentMethodId: id })

    await sendCardExpiringNotices(propertyId, now)
    expect(
      await prisma.notification.count({
        where: { recipientId: tenant.id, templateKey: 'payment.card_expiring' },
      }),
    ).toBe(0)
  }, 30_000)

  it('stays silent for an already-expired card, past this month', async () => {
    const id = `pm_${randomUUID().slice(0, 10)}`
    const now = expiryFixture(id, new Date(), -60) // 60 days AFTER its expiry month
    const { tenant } = await seedPayer({ defaultPaymentMethodId: id })

    await sendCardExpiringNotices(propertyId, now)
    expect(
      await prisma.notification.count({
        where: { recipientId: tenant.id, templateKey: 'payment.card_expiring' },
      }),
    ).toBe(0)
  }, 30_000)

  it('does NOT check a payer with no payment method on file', async () => {
    const { tenant } = await seedPayer({ defaultPaymentMethodId: null })

    await sendCardExpiringNotices(propertyId, new Date())
    expect(
      await prisma.notification.count({
        where: { recipientId: tenant.id, templateKey: 'payment.card_expiring' },
      }),
    ).toBe(0)
  }, 30_000)

  it('warns ONCE for the same card, whatever the calendar day', async () => {
    // Keyed on the CARD'S OWN EXPIRY, not on today. Running the scan on two
    // different days inside the same warning window must not send twice.
    const id = `pm_${randomUUID().slice(0, 10)}`
    const now = expiryFixture(id, new Date(), 20)
    const { tenant } = await seedPayer({ defaultPaymentMethodId: id })

    await sendCardExpiringNotices(propertyId, now)
    const after = await prisma.notification.count({
      where: { recipientId: tenant.id, templateKey: 'payment.card_expiring' },
    })
    // One day later, still inside the window.
    await sendCardExpiringNotices(propertyId, new Date(now.getTime() + 86_400_000))

    expect(
      await prisma.notification.count({
        where: { recipientId: tenant.id, templateKey: 'payment.card_expiring' },
      }),
    ).toBe(after)
  }, 30_000)
})
