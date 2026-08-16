import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dashboardSummary } from './queries.ts'

// One shared fixture across every tile, scoped-vs-out-of-scope, rather than a
// fixture per tile - "entity filter throughout" (R-050's own requirement) is
// exactly the thing worth proving once, end to end, against a real query.
//
// delinquencySummary and renewalAlertsSummary are DELIBERATELY NOT covered
// here. Both are two-line pass-throughs to an already-tested lower layer -
// rentRoll (R-044) and filingCabinetAlertsDue/insuranceRenewalDue (R-015,
// core-tested in packages/core/filing-cabinet) - and the pure logic behind
// every other tile (ticketGlows, daysOnMarket, dailyCostOfVacancyCents,
// daysUntilExpiry, expiryWindow) already has its own packages/core test.
// What's untested anywhere else, and what this file exists to prove, is the
// SQL/scoping wiring: does the right where-clause reach the right rows.

const stamp = `dash-${Date.now()}`
let entityId: string
let propInScope: string
let propOutOfScope: string
const asOf = new Date('2026-08-15T18:00:00.000Z') // 13:00 America/Chicago

const cleanup = {
  properties: [] as string[],
  units: [] as string[],
  leases: [] as string[],
  payers: [] as string[],
  payments: [] as string[],
  tickets: [] as string[],
  tasks: [] as string[],
}

beforeAll(async () => {
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id

  const makeProperty = async (name: string) => {
    const p = await prisma.property.create({
      data: {
        legalEntityId: entityId,
        name: `${stamp}-${name}`,
        addressLine1: '1 Test St',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })
    cleanup.properties.push(p.id)
    return p.id
  }
  propInScope = await makeProperty('in')
  propOutOfScope = await makeProperty('out')

  // Builds one full set of fixtures (occupied+vacant units, a month-to-month
  // lease and two term leases, tickets across every open/closed status, one
  // approval task) against whichever property is passed in, so the
  // out-of-scope property can mirror the in-scope one exactly and any leak
  // shows up as a wrong number rather than an absent one.
  async function seedProperty(propertyId: string, rentBase: number) {
    const occupied = await prisma.unit.create({
      data: { propertyId, name: 'Occupied', status: 'OCCUPIED' },
    })
    const vacant = await prisma.unit.create({
      data: {
        propertyId,
        name: 'Vacant',
        status: 'VACANT',
        marketRentCents: 90_000,
        createdAt: new Date('2026-08-05T12:00:00.000Z'), // 10 days on market
      },
    })
    const makeReady = await prisma.unit.create({
      data: {
        propertyId,
        name: 'Make-ready',
        status: 'MAKE_READY',
        createdAt: new Date('2020-01-01T12:00:00.000Z'), // superseded by moveOutAt below
      },
    })
    const termUnitA = await prisma.unit.create({ data: { propertyId, name: 'Term A', status: 'OCCUPIED' } })
    const termUnitB = await prisma.unit.create({ data: { propertyId, name: 'Term B', status: 'OCCUPIED' } })
    cleanup.units.push(occupied.id, vacant.id, makeReady.id, termUnitA.id, termUnitB.id)

    const mtm = await prisma.lease.create({
      data: {
        propertyId,
        unitId: occupied.id,
        status: 'MONTH_TO_MONTH',
        startsOn: new Date('2025-01-01'),
        rentCents: rentBase,
      },
    })
    // The vacancy this make-ready unit's daysOnMarket must read from -
    // moveOutAt, not unitCreatedAt (that's the whole point of the fixture).
    const endedLease = await prisma.lease.create({
      data: {
        propertyId,
        unitId: makeReady.id,
        status: 'ENDED',
        startsOn: new Date('2024-01-01'),
        endsOn: new Date('2026-08-10'),
        moveOutAt: new Date('2026-08-10T12:00:00.000Z'), // 5 days on market
        rentCents: rentBase,
      },
    })
    const within90 = await prisma.lease.create({
      data: {
        propertyId,
        unitId: termUnitA.id,
        status: 'ACTIVE',
        startsOn: new Date('2026-01-01'),
        endsOn: new Date('2026-10-14'), // 60 days out
        rentCents: rentBase + 20_000,
      },
    })
    const within120Only = await prisma.lease.create({
      data: {
        propertyId,
        unitId: termUnitB.id,
        status: 'ACTIVE',
        startsOn: new Date('2026-01-01'),
        endsOn: new Date('2026-11-23'), // 100 days out
        rentCents: rentBase + 30_000,
      },
    })
    cleanup.leases.push(mtm.id, endedLease.id, within90.id, within120Only.id)

    const payer = await prisma.leasePayer.create({
      data: { leaseId: mtm.id, propertyId, payerType: 'TENANT' },
    })
    cleanup.payers.push(payer.id)
    const payment = await prisma.payment.create({
      data: {
        propertyId,
        leaseId: mtm.id,
        leasePayerId: payer.id,
        channel: 'ACH',
        status: 'SETTLED',
        amountCents: rentBase,
        receivedAt: new Date('2026-08-10T12:00:00.000Z'), // inside this month
      },
    })
    cleanup.payments.push(payment.id)

    const ticketBase = { propertyId, unitId: occupied.id, source: 'STAFF' as const, category: 'other', description: 'x' }
    const glowing = await prisma.ticket.create({
      data: { ...ticketBase, priority: 'EMERGENCY', status: 'NEW', createdAt: new Date('2026-08-13T16:00:00.000Z') }, // 50h old
    })
    const routineOld = await prisma.ticket.create({
      data: { ...ticketBase, priority: 'ROUTINE', status: 'NEW', createdAt: new Date('2020-01-01T00:00:00.000Z') },
    })
    const waitingOnTenant = await prisma.ticket.create({
      data: { ...ticketBase, priority: 'URGENT', status: 'WAITING_ON_TENANT', createdAt: new Date('2026-08-15T17:00:00.000Z') }, // 1h old
    })
    const closedEmergency = await prisma.ticket.create({
      // Would glow if open - proves closed tickets are excluded from the
      // count entirely, not just from the glow.
      data: { ...ticketBase, priority: 'EMERGENCY', status: 'CLOSED', createdAt: new Date('2020-01-01T00:00:00.000Z') },
    })
    cleanup.tickets.push(glowing.id, routineOld.id, waitingOnTenant.id, closedEmergency.id)

    const taskBase = { propertyId, subjectType: 'WorkOrder', businessDate: new Date('2026-08-15'), title: 'Approve estimate' }
    const openApproval = await prisma.task.create({
      data: { ...taskBase, type: 'workorder_approval', subjectId: `${propertyId}-wo-1`, status: 'OPEN' },
    })
    const doneApproval = await prisma.task.create({
      data: { ...taskBase, type: 'workorder_approval', subjectId: `${propertyId}-wo-2`, status: 'DONE' },
    })
    const wrongType = await prisma.task.create({
      data: { ...taskBase, type: 'something_else', subjectId: `${propertyId}-other-1`, status: 'OPEN' },
    })
    cleanup.tasks.push(openApproval.id, doneApproval.id, wrongType.id)
  }

  await seedProperty(propInScope, 150_000)
  await seedProperty(propOutOfScope, 999_000) // deliberately different, so a leak shows up as a wrong number
})

afterAll(async () => {
  await prisma.task.deleteMany({ where: { id: { in: cleanup.tasks } } })
  await prisma.ticket.deleteMany({ where: { id: { in: cleanup.tickets } } })
  await prisma.payment.deleteMany({ where: { id: { in: cleanup.payments } } })
  await prisma.leasePayer.deleteMany({ where: { id: { in: cleanup.payers } } })
  await prisma.lease.deleteMany({ where: { id: { in: cleanup.leases } } })
  await prisma.unit.deleteMany({ where: { id: { in: cleanup.units } } })
  await prisma.property.deleteMany({ where: { id: { in: cleanup.properties } } })
  await prisma.legalEntity.delete({ where: { id: entityId } })
  await prisma.$disconnect()
})

function scopeOf(propertyIds: string[]) {
  return {
    selection: { kind: 'all' as const },
    availableEntities: [],
    availableProperties: [],
    propertyIds,
    switchable: propertyIds.length > 1,
  }
}

describe('dashboardSummary', () => {
  it('computes every tile from the in-scope property only', async () => {
    const summary = await dashboardSummary(scopeOf([propInScope]), asOf)

    expect(summary.collectedVsBilled).toEqual({
      billedCents: 150_000 + 170_000 + 180_000, // mtm + within90 + within120
      collectedCents: 150_000,
      periodLabel: 'August 2026',
    })

    expect(summary.tickets).toEqual({ openCount: 3, glowingCount: 1 })

    expect(summary.vacancies).toEqual({
      count: 2, // vacant + make-ready; the two occupied term units don't count
      totalDailyCostCents: 3_000, // 90_000 / 30, the make-ready unit has no asking rent
      longestDaysOnMarket: 10,
    })

    expect(summary.leaseExpiry).toEqual({ within90: 1, within120: 2 })

    expect(summary.pendingApprovals).toEqual({ count: 1 })
  })

  it('leaks nothing from a property outside scope', async () => {
    const summary = await dashboardSummary(scopeOf([propOutOfScope]), asOf)
    expect(summary.collectedVsBilled.billedCents).toBe(999_000 + 1_019_000 + 1_029_000)
    expect(summary.tickets.openCount).toBe(3)
    expect(summary.vacancies.count).toBe(2)
  })

  it('returns every tile at zero for an empty scope, rather than querying unfiltered', async () => {
    const summary = await dashboardSummary(scopeOf([]), asOf)
    expect(summary.collectedVsBilled).toEqual({ billedCents: 0, collectedCents: 0, periodLabel: '' })
    expect(summary.tickets).toEqual({ openCount: 0, glowingCount: 0 })
    expect(summary.vacancies).toEqual({ count: 0, totalDailyCostCents: 0, longestDaysOnMarket: 0 })
    expect(summary.leaseExpiry).toEqual({ within90: 0, within120: 0 })
    expect(summary.pendingApprovals).toEqual({ count: 0 })
  })
})
