import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { retaliationCheckFor } from './retaliation-check.ts'

// The database half of the retaliation-claim guard (RISK-06, R-055), against
// real Texas config (retaliationWindowDays: 180, seeded/backfilled by
// packages/db/prisma/seed.mts) and a real habitability-flagged Ticket - the
// exact signal R-023 already stamps at intake, which is the whole reason
// this item did not have to build its own complaint log.

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string
const leaseIds: string[] = []
const ticketIds: string[] = []

beforeAll(async () => {
  const stamp = `retaliation-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '5 Retaliation Row',
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
    data: { firstName: 'Complaint', lastName: `Filer-${randomUUID().slice(0, 6)}` },
  })
  tenantId = tenant.id
})

afterAll(async () => {
  // Ticket has no delete-blocking append-only trigger of its own, but it is
  // referenced by Message/WorkOrder relations in general - deleting only
  // what this file created, none of which has either.
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
  await prisma.unit.deleteMany({ where: { id: unitId } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function seedLease() {
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
      depositCents: 150_000,
      isMonthToMonth: true,
      leaseTenants: { create: { tenantId } },
    },
  })
  leaseIds.push(lease.id)
  return lease
}

async function seedHabitabilityTicket(leaseId: string, createdAt: Date) {
  const ticket = await prisma.ticket.create({
    data: {
      propertyId,
      unitId,
      leaseId,
      tenantId,
      source: 'PORTAL',
      category: 'no heat',
      description: 'The furnace stopped working.',
      habitabilityFlag: true,
      createdAt,
    },
  })
  ticketIds.push(ticket.id)
  return ticket
}

describe('retaliationCheckFor', () => {
  it('warns when the most recent habitability ticket falls inside the configured window', async () => {
    const lease = await seedLease()
    const now = new Date()
    await seedHabitabilityTicket(lease.id, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000))

    const warning = await retaliationCheckFor({
      leaseId: lease.id,
      propertyState: 'TX',
      propertyCounty: null,
      actionDate: now,
    })

    expect(warning).not.toBeNull()
    expect(warning?.windowDays).toBe(180)
    expect(warning?.category).toBe('no heat')
  })

  it('is silent when there is no habitability ticket on this lease', async () => {
    const lease = await seedLease()

    const warning = await retaliationCheckFor({
      leaseId: lease.id,
      propertyState: 'TX',
      propertyCounty: null,
      actionDate: new Date(),
    })

    expect(warning).toBeNull()
  })

  it('is silent when a habitability ticket exists but is outside the window', async () => {
    const lease = await seedLease()
    const now = new Date()
    await seedHabitabilityTicket(lease.id, new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000))

    const warning = await retaliationCheckFor({
      leaseId: lease.id,
      propertyState: 'TX',
      propertyCounty: null,
      actionDate: now,
    })

    expect(warning).toBeNull()
  })

  it('is silent, not thrown, for a state with no JurisdictionRule configured at all', async () => {
    const lease = await seedLease()
    await seedHabitabilityTicket(lease.id, new Date())

    // A property outside this product's footprint states - see
    // JurisdictionRuleNotFoundError's own comment. The guard has nothing to
    // warn about with, and must not turn "unconfigured" into a 500.
    const warning = await retaliationCheckFor({
      leaseId: lease.id,
      propertyState: 'ZZ',
      propertyCounty: null,
      actionDate: new Date(),
    })

    expect(warning).toBeNull()
  })

  it('ignores a non-habitability ticket, however recent', async () => {
    const lease = await seedLease()
    const ticket = await prisma.ticket.create({
      data: {
        propertyId,
        unitId,
        leaseId: lease.id,
        tenantId,
        source: 'PORTAL',
        category: 'squeaky door',
        description: 'A hinge needs oil.',
        habitabilityFlag: false,
      },
    })
    ticketIds.push(ticket.id)

    const warning = await retaliationCheckFor({
      leaseId: lease.id,
      propertyState: 'TX',
      propertyCounty: null,
      actionDate: new Date(),
    })

    expect(warning).toBeNull()
  })
})
