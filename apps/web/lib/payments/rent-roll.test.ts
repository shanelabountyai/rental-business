import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rentRoll } from './rent-roll.ts'

// R-231: the rent roll used to name whichever tenant the database happened
// to return first on a joint lease, and `lastContactOn` only ever checked
// that one tenant. Both are now `isPrimary`-ordered / computed across every
// party on the lease (review finding 10).

let propertyId: string
let leaseId: string
let primaryTenantId: string
let coTenantId: string

beforeAll(async () => {
  const stamp = `rentroll-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${stamp}-house`,
      addressLine1: '9 Roll Rd',
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
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  leaseId = lease.id

  const coTenant = await prisma.tenant.create({
    data: { firstName: 'Zed', lastName: `CoTenant-${randomUUID().slice(0, 6)}` },
  })
  coTenantId = coTenant.id
  const primaryTenant = await prisma.tenant.create({
    data: { firstName: 'Ann', lastName: `Primary-${randomUUID().slice(0, 6)}` },
  })
  primaryTenantId = primaryTenant.id

  // Co-tenant inserted FIRST and is not primary - a naive `[0]` with no
  // `orderBy` would pick this row on a fresh insert-order scan.
  await prisma.leaseTenant.create({ data: { leaseId, tenantId: coTenantId, isPrimary: false } })
  await prisma.leaseTenant.create({ data: { leaseId, tenantId: primaryTenantId, isPrimary: true } })

  // The co-tenant was reached more recently than the primary tenant.
  const primaryThread = await prisma.thread.create({
    data: { propertyId, tenantId: primaryTenantId, key: `thread-primary-${randomUUID()}` },
  })
  await prisma.message.create({
    data: {
      threadId: primaryThread.id,
      channel: 'SMS',
      direction: 'OUTBOUND',
      body: 'reminder',
      sentAt: new Date('2026-01-05T12:00:00Z'),
      tenantId: primaryTenantId,
    },
  })
  const coThread = await prisma.thread.create({
    data: { propertyId, tenantId: coTenantId, key: `thread-co-${randomUUID()}` },
  })
  await prisma.message.create({
    data: {
      threadId: coThread.id,
      channel: 'SMS',
      direction: 'OUTBOUND',
      body: 'reminder',
      sentAt: new Date('2026-03-10T12:00:00Z'),
      tenantId: coTenantId,
    },
  })
})

afterAll(async () => {
  await prisma.tenant.updateMany({
    where: { id: { in: [primaryTenantId, coTenantId] } },
    data: { active: false },
  })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.$disconnect()
})

describe('rentRoll (R-231, review finding 10)', () => {
  it('names the primary tenant regardless of insertion order, and dates contact across every party', async () => {
    const { rows } = await rentRoll({ propertyIds: [propertyId] })
    const row = rows.find((r) => r.leaseId === leaseId)
    expect(row).toBeDefined()
    expect(row!.tenantId).toBe(primaryTenantId)
    expect(row!.tenantName).toContain('Primary-')
    // The co-tenant's later message, not the primary's earlier one.
    expect(row!.lastContactOn).toBe('2026-03-10')
  }, 20_000)

  // `collectionMethod` defaults to charge_automatically, so a payer who never
  // saved a card read "autopay" to staff while their portal offered to turn it
  // on. Autopay needs the saved method too, as `queries.ts` already says.
  it('reports autopay only when a payer debits automatically AND has a payment method on file', async () => {
    const payer = await prisma.leasePayer.create({
      data: { leaseId, propertyId, payerType: 'TENANT', tenantId: primaryTenantId, collectionMethod: 'charge_automatically' },
    })
    const autopay = async () => (await rentRoll({ propertyIds: [propertyId] })).rows.find((r) => r.leaseId === leaseId)!.autopay

    expect(await autopay()).toBe(false)
    await prisma.leasePayer.update({ where: { id: payer.id }, data: { defaultPaymentMethodId: `pm_${randomUUID()}` } })
    expect(await autopay()).toBe(true)
  }, 20_000)
})
