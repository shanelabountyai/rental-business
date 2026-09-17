import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runDueJobs } from '../jobs/runner.ts'
// Side-effect import: registers only this job into this file's SCHEDULED_JOBS.
import './prepare-job.ts'

// R-219: a notice to vacate raises a listing.prepare Task, dated on the notice
// day, unless a listing is already live or was started since the notice.

const CHICAGO = 'America/Chicago'

let entityId: string
const propertyIds: string[] = []
const unitIds: string[] = []

beforeAll(async () => {
  const entity = await prisma.legalEntity.create({
    data: { name: `ListingPrepare LLC-${Date.now()}`, type: 'LLC' },
  })
  entityId = entity.id
})

afterEach(async () => {
  await prisma.task.deleteMany({ where: { subjectId: { in: unitIds } } })
  await prisma.listing.deleteMany({ where: { unitId: { in: unitIds } } })
  await prisma.lease.deleteMany({ where: { unitId: { in: unitIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.jobRun.deleteMany({ where: { propertyId: { in: propertyIds } } })
  unitIds.length = 0
})

afterAll(async () => {
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedLease(notice: { givenAt: string } | null) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `ListingPrepare House-${unique}`,
      addressLine1: '1 Notice Ln',
      city: 'Anytown',
      state: 'TX',
      postalCode: '00000',
      timezone: CHICAGO,
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({ data: { propertyId: property.id, name: `U-${unique}`, status: 'OCCUPIED' } })
  unitIds.push(unit.id)
  await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2025-01-01T00:00:00Z'),
      rentCents: 150_000,
      ...(notice && {
        noticeGivenAt: new Date(notice.givenAt),
        noticeGivenBy: 'TENANT' as const,
        noticeEffectiveOn: new Date('2026-09-30T00:00:00Z'),
      }),
    },
  })
  return { property, unit }
}

function tasksFor(unitId: string) {
  return prisma.task.findMany({ where: { type: 'listing.prepare', subjectId: unitId } })
}

describe('the listing.prepare job', () => {
  it('raises one Task per notice, dated on the notice day in the property zone, however often it runs', async () => {
    // 02:00Z on 1 Sep is still 31 Aug in Chicago.
    const { property, unit } = await seedLease({ givenAt: '2026-09-01T02:00:00Z' })

    await runDueJobs(new Date('2026-09-02T12:00:00Z'), { propertyIds: [property.id] })
    await runDueJobs(new Date('2026-09-03T12:00:00Z'), { propertyIds: [property.id] })

    const tasks = await tasksFor(unit.id)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].subjectType).toBe('Unit')
    expect(tasks[0].businessDate.toISOString().slice(0, 10)).toBe('2026-08-31')
    expect(tasks[0].title).toContain('30 Sept 2026')
  })

  it('stays quiet when a listing was started after the notice', async () => {
    const { property, unit } = await seedLease({ givenAt: '2026-09-01T15:00:00Z' })
    await prisma.listing.create({
      data: { propertyId: property.id, unitId: unit.id, rentCents: 150_000, availableOn: new Date('2026-10-01T00:00:00Z') },
    })

    await runDueJobs(new Date('2026-09-02T12:00:00Z'), { propertyIds: [property.id] })

    expect(await tasksFor(unit.id)).toHaveLength(0)
  })

  it('is not silenced by a draft left over from the previous vacancy', async () => {
    const { property, unit } = await seedLease({ givenAt: '2026-09-01T15:00:00Z' })
    await prisma.listing.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        rentCents: 140_000,
        availableOn: new Date('2025-01-01T00:00:00Z'),
        createdAt: new Date('2024-12-01T00:00:00Z'),
      },
    })

    await runDueJobs(new Date('2026-09-02T12:00:00Z'), { propertyIds: [property.id] })

    expect(await tasksFor(unit.id)).toHaveLength(1)
  })

  it('ignores a lease with no notice', async () => {
    const { property, unit } = await seedLease(null)

    await runDueJobs(new Date('2026-09-02T12:00:00Z'), { propertyIds: [property.id] })

    expect(await tasksFor(unit.id)).toHaveLength(0)
  })
})
