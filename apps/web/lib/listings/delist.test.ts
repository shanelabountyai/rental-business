import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { emitEvent, dispatchOutbox } from '../jobs/outbox.ts'
// Side-effect import: registers the real consumer into this file's own
// CONSUMERS (Vitest isolates modules per test file) - same convention
// apps/web/lib/units/auto-make-ready.test.ts already uses for its job.
import './delist-consumer.ts'
import { sweepPendingDelists } from './delist-sweep.ts'
import { SimulatedSyndicationAdapter } from './simulated-adapter.ts'

// "≤24h delist on lease-up" (LEASE-02, R-057, D-7), against a real
// database. `changeLeaseStatus` itself is session-dependent
// (requirePermission) and covered by e2e instead - this drives the same
// fact a real activation produces (a `lease.activated` event) directly, the
// same split apps/web/lib/notices/notices.test.ts already documents.

let entityId: string
let propertyId: string
const unitIds: string[] = []
const listingIds: string[] = []
const syndicationIds: string[] = []

beforeAll(async () => {
  const stamp = `delist-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '9 Leased Up Lane',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
})

afterEach(async () => {
  await prisma.listingSyndication.deleteMany({ where: { id: { in: syndicationIds } } })
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  // Same order auto-make-ready.test.ts documents: a real registered
  // consumer may have already processed the event, leaving an
  // EventConsumption row the OutboxEvent's own RESTRICT would otherwise
  // block deleting first.
  await prisma.eventConsumption.deleteMany({ where: { event: { propertyId } } })
  await prisma.outboxEvent.deleteMany({ where: { propertyId } })
  syndicationIds.length = 0
  listingIds.length = 0
  unitIds.length = 0
})

afterAll(async () => {
  // AuditLog is append-only (trigger-enforced) - this test's own
  // listing.unpublished rows are left standing, same as everywhere else in
  // this codebase's test suite. Deactivating the property is what keeps a
  // re-run from tripping over this run's fixtures.
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function seedPublishedListing() {
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
  })
  unitIds.push(unit.id)
  const listing = await prisma.listing.create({
    data: {
      propertyId,
      unitId: unit.id,
      status: 'PUBLISHED',
      rentCents: 150_000,
      availableOn: new Date('2026-09-01'),
      publishedAt: new Date(),
    },
  })
  listingIds.push(listing.id)
  return { unit, listing }
}

describe('delist-consumer: lease.activated -> listing goes UNPUBLISHED', () => {
  it('unpublishes the unit\'s PUBLISHED listing', async () => {
    const { unit, listing } = await seedPublishedListing()
    const leaseId = `fake-lease-${randomUUID()}`

    await emitEvent(prisma, {
      type: 'lease.activated',
      aggregateType: 'Lease',
      aggregateId: leaseId,
      propertyId,
      payload: { unitId: unit.id },
    })
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { type: 'lease.activated', aggregateId: leaseId },
    })
    const result = await dispatchOutbox(100, { eventIds: [event.id] })
    expect(result.failed).toBe(0)

    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })
    expect(after.status).toBe('UNPUBLISHED')

    const audited = await prisma.auditLog.findFirst({
      where: { action: 'listing.unpublished', entityId: listing.id },
    })
    expect(audited?.actorType).toBe('SYSTEM')
  })

  it('does nothing when the unit has no PUBLISHED listing', async () => {
    const unit = await prisma.unit.create({
      data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
    })
    unitIds.push(unit.id)
    const leaseId = `fake-lease-${randomUUID()}`

    await emitEvent(prisma, {
      type: 'lease.activated',
      aggregateType: 'Lease',
      aggregateId: leaseId,
      propertyId,
      payload: { unitId: unit.id },
    })
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { type: 'lease.activated', aggregateId: leaseId },
    })
    const result = await dispatchOutbox(100, { eventIds: [event.id] })
    expect(result.failed).toBe(0)
    // Nothing to assert beyond "it did not throw" - there is no listing to
    // have changed.
  })
})

describe('delist-sweep: reconciling the network side', () => {
  it('delists a LISTED row on an UNPUBLISHED listing, and leaves a PUBLISHED one alone', async () => {
    const { listing: unpublished } = await seedPublishedListing()
    await prisma.listing.update({ where: { id: unpublished.id }, data: { status: 'UNPUBLISHED' } })
    const pendingRow = await prisma.listingSyndication.create({
      data: {
        listingId: unpublished.id,
        network: 'ZILLOW',
        status: 'LISTED',
        externalId: 'zillow_test123',
        listedAt: new Date(),
      },
    })
    syndicationIds.push(pendingRow.id)

    const { listing: stillPublished } = await seedPublishedListing()
    const liveRow = await prisma.listingSyndication.create({
      data: {
        listingId: stillPublished.id,
        network: 'ZUMPER',
        status: 'LISTED',
        externalId: 'zumper_test456',
        listedAt: new Date(),
      },
    })
    syndicationIds.push(liveRow.id)

    const adapter = new SimulatedSyndicationAdapter()
    const result = await sweepPendingDelists(adapter)
    expect(result.delisted).toBeGreaterThanOrEqual(1)

    const after = await prisma.listingSyndication.findUniqueOrThrow({
      where: { id: pendingRow.id },
    })
    expect(after.status).toBe('DELISTED')
    expect(after.delistedAt).not.toBeNull()

    const untouched = await prisma.listingSyndication.findUniqueOrThrow({
      where: { id: liveRow.id },
    })
    expect(untouched.status).toBe('LISTED')
  })

  it('is self-healing: a faulted delist stays LISTED and is retried next sweep', async () => {
    const { listing } = await seedPublishedListing()
    await prisma.listing.update({ where: { id: listing.id }, data: { status: 'UNPUBLISHED' } })
    const row = await prisma.listingSyndication.create({
      data: {
        listingId: listing.id,
        network: 'ZILLOW',
        status: 'LISTED',
        externalId: 'zillow_flaky',
        listedAt: new Date(),
      },
    })
    syndicationIds.push(row.id)

    const faulting = new SimulatedSyndicationAdapter({ fault: () => 'timeout' })
    await sweepPendingDelists(faulting)

    const afterFault = await prisma.listingSyndication.findUniqueOrThrow({ where: { id: row.id } })
    // Still LISTED - a failed delist must not silently look successful, and
    // the query the NEXT sweep runs is the same one that already found it.
    expect(afterFault.status).toBe('LISTED')
    expect(afterFault.lastFaultCode).toBe('timeout')

    const healthy = new SimulatedSyndicationAdapter()
    const secondSweep = await sweepPendingDelists(healthy)
    expect(secondSweep.delisted).toBeGreaterThanOrEqual(1)

    const afterRetry = await prisma.listingSyndication.findUniqueOrThrow({ where: { id: row.id } })
    expect(afterRetry.status).toBe('DELISTED')
  })
})
