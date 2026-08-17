import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'
import { listingForUnit, publicListing, unitPhotosForListing } from './queries.ts'

// The database half of LEASE-01 (R-056): scoping (listingForUnit) and the
// PUBLISHED-only read the hosted page relies on (publicListing). Server
// actions that call requirePermission() are session-dependent and covered
// by e2e/listings.spec.ts instead - see apps/web/lib/notices/notices.test.ts
// for the same split and why.

function scopeOf(propertyIds: string[]): ResolvedScope {
  return {
    selection: { kind: 'all' },
    availableEntities: [],
    availableProperties: [],
    propertyIds,
    switchable: false,
  }
}

let entityId: string
let propertyId: string
let unitId: string
const listingIds: string[] = []
const documentIds: string[] = []

beforeAll(async () => {
  const stamp = `listing-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '14 Vacancy Court',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `U-${randomUUID().slice(0, 6)}`, status: 'VACANT' },
  })
  unitId = unit.id
})

afterAll(async () => {
  await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } })
  await prisma.unit.deleteMany({ where: { id: unitId } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function seedListing(overrides: { status?: 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED' } = {}) {
  const listing = await prisma.listing.create({
    data: {
      propertyId,
      unitId,
      status: overrides.status ?? 'DRAFT',
      rentCents: 150_000,
      availableOn: new Date('2026-09-01'),
    },
  })
  listingIds.push(listing.id)
  return listing
}

describe('listingForUnit', () => {
  it('returns the most recent listing for a unit in scope', async () => {
    await seedListing({ status: 'UNPUBLISHED' })
    // A short delay so createdAt orders deterministically - Postgres
    // timestamp resolution is finer than this, but two creates in the same
    // millisecond is not impossible on a fast test run.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const latest = await seedListing({ status: 'DRAFT' })

    const found = await listingForUnit(unitId, scopeOf([propertyId]))
    expect(found?.id).toBe(latest.id)
  })

  it('returns null for a unit outside the actor scope', async () => {
    const listing = await seedListing()
    const found = await listingForUnit(unitId, scopeOf(['some-other-property']))
    expect(found).toBeNull()
    expect(listing).toBeTruthy()
  })
})

describe('publicListing', () => {
  it('returns a PUBLISHED listing', async () => {
    const listing = await seedListing({ status: 'PUBLISHED' })
    const found = await publicListing(listing.id)
    expect(found?.id).toBe(listing.id)
    expect(found?.property.state).toBe('TX')
  })

  it('is null for a DRAFT listing - not yours and does not exist read the same', async () => {
    const listing = await seedListing({ status: 'DRAFT' })
    expect(await publicListing(listing.id)).toBeNull()
  })

  it('is null for an UNPUBLISHED listing', async () => {
    const listing = await seedListing({ status: 'UNPUBLISHED' })
    expect(await publicListing(listing.id)).toBeNull()
  })

  it('is null for an id that does not exist at all', async () => {
    expect(await publicListing('not-a-real-id')).toBeNull()
  })
})

describe('unitPhotosForListing', () => {
  it('reads the unit photo library live, filtered to UNIT_PHOTO and not soft-deleted', async () => {
    const photo = await prisma.document.create({
      data: {
        propertyId,
        unitId,
        type: 'UNIT_PHOTO',
        fileName: 'kitchen.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 100,
        storageKey: `test/${randomUUID()}`,
      },
    })
    documentIds.push(photo.id)
    const other = await prisma.document.create({
      data: {
        propertyId,
        unitId,
        type: 'LEASE',
        fileName: 'lease.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
        storageKey: `test/${randomUUID()}`,
      },
    })
    documentIds.push(other.id)
    const deleted = await prisma.document.create({
      data: {
        propertyId,
        unitId,
        type: 'UNIT_PHOTO',
        fileName: 'old-hallway.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 100,
        storageKey: `test/${randomUUID()}`,
        deletedAt: new Date(),
      },
    })
    documentIds.push(deleted.id)

    const photos = await unitPhotosForListing(unitId)
    expect(photos.map((p) => p.id)).toEqual([photo.id])
  })
})
