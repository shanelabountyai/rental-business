import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bookShowing, sendShowingInvite } from './actions.ts'
import { showingLinkStatus } from './link.ts'
import { availableSlotsFor } from './queries.ts'
import { sweepShowingReminders } from './reminders.ts'

// The database half of LEASE-08 (R-064) - everything except cancelShowing
// (session-dependent, requirePermission - see prospects.test.ts's own header
// for the identical split, and e2e/showings.spec.ts for that coverage).

vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))

let entityId: string
let propertyId: string
let vacantUnitId: string
let occupiedUnitId: string
let vacantListingId: string
let occupiedListingId: string
let tenantId: string
const prospectIds: string[] = []
const showingIds: string[] = []
const leaseIds: string[] = []

beforeAll(async () => {
  const stamp = `showing-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '90 Pipeline Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
      yearBuilt: 2015,
    },
  })
  propertyId = property.id

  const vacantUnit = await prisma.unit.create({
    data: { propertyId, name: `V-${randomUUID().slice(0, 6)}`, status: 'VACANT' },
  })
  vacantUnitId = vacantUnit.id
  const vacantListing = await prisma.listing.create({
    data: {
      propertyId,
      unitId: vacantUnitId,
      status: 'PUBLISHED',
      rentCents: 150_000,
      availableOn: new Date('2026-09-01'),
      publishedAt: new Date(),
    },
  })
  vacantListingId = vacantListing.id

  const occupiedUnit = await prisma.unit.create({
    data: { propertyId, name: `O-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
  })
  occupiedUnitId = occupiedUnit.id
  const occupiedListing = await prisma.listing.create({
    data: {
      propertyId,
      unitId: occupiedUnitId,
      status: 'PUBLISHED',
      rentCents: 160_000,
      availableOn: new Date('2026-10-01'),
      publishedAt: new Date(),
    },
  })
  occupiedListingId = occupiedListing.id

  const tenant = await prisma.tenant.create({
    data: { firstName: 'Cur', lastName: 'Rent', email: `cur-${randomUUID().slice(0, 8)}@example.test` },
  })
  tenantId = tenant.id
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId: occupiedUnitId,
      status: 'ACTIVE',
      startsOn: new Date('2025-01-01'),
      rentCents: 160_000,
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId, isPrimary: true } })
})

afterAll(async () => {
  // NoticeDelivery is append-only, and every FK below a Showing is RESTRICT
  // (Notice, Lease, Unit, Listing, Prospect all included) - so once a
  // Showing exists, nothing it points at can be deleted. Same shape
  // notices.test.ts's own header documents for the identical reason: proof
  // outlives the fixtures that produced it. Only the roots that CAN be
  // retired are - deactivating the property is what keeps this debris out
  // of every live query.
  await prisma.showing.updateMany({ where: { id: { in: showingIds } }, data: { status: 'CANCELED' } })
  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function seedProspect(listingId: string) {
  const prospect = await prisma.prospect.create({
    data: {
      propertyId,
      listingId,
      firstName: 'Sam',
      lastName: `Booker-${randomUUID().slice(0, 6)}`,
      email: `sam-${randomUUID().slice(0, 8)}@example.test`,
      source: 'direct',
      status: 'PRE_SCREENED',
      preScreenRespondedAt: new Date(),
    },
  })
  prospectIds.push(prospect.id)
  return prospect
}

async function tokenFor(prospectId: string): Promise<string> {
  await sendShowingInvite(prospectId)
  const notification = await prisma.notification.findFirstOrThrow({
    where: { recipientType: 'PROSPECT', recipientId: prospectId },
    orderBy: { createdAt: 'desc' },
  })
  const match = /\/showings\/([^\s]+)/.exec(notification.body)
  if (!match) throw new Error('no showing link found in the rendered notification body')
  return match[1]!
}

describe('sendShowingInvite', () => {
  it('mints a booking link and sends it', async () => {
    const prospect = await seedProspect(vacantListingId)
    await sendShowingInvite(prospect.id)

    const notification = await prisma.notification.findFirstOrThrow({
      where: { recipientType: 'PROSPECT', recipientId: prospect.id },
    })
    expect(notification.category).toBe('prospect_showing')
    expect(notification.templateKey).toBe('showing.invite')
  })
})

describe('availableSlotsFor', () => {
  it('offers slots for a vacant unit with no entry-notice floor', async () => {
    const slots = await availableSlotsFor(
      { id: vacantUnitId, status: 'VACANT' },
      { state: 'TX', county: null, timezone: 'America/Chicago' },
      new Date(),
    )
    expect(slots.length).toBeGreaterThan(0)
  })

  it('offers nothing before 24h for an occupied unit - TX seeds entryNoticeHours: 24', async () => {
    const now = new Date()
    const slots = await availableSlotsFor(
      { id: occupiedUnitId, status: 'OCCUPIED' },
      { state: 'TX', county: null, timezone: 'America/Chicago' },
      now,
    )
    for (const slot of slots) {
      expect(slot.getTime()).toBeGreaterThanOrEqual(now.getTime() + 24 * 3_600_000)
    }
  })
})

describe('bookShowing', () => {
  it('books a vacant-unit slot with no entry notice, and raises an escort task', async () => {
    const prospect = await seedProspect(vacantListingId)
    const token = await tokenFor(prospect.id)
    const slots = await availableSlotsFor(
      { id: vacantUnitId, status: 'VACANT' },
      { state: 'TX', county: null, timezone: 'America/Chicago' },
      new Date(),
    )

    const formData = new FormData()
    formData.set('slot', slots[0]!.toISOString())
    const result = await bookShowing(token, {}, formData)
    expect(result.error).toBeUndefined()

    const showing = await prisma.showing.findFirstOrThrow({ where: { prospectId: prospect.id } })
    showingIds.push(showing.id)
    expect(showing.status).toBe('BOOKED')
    expect(showing.entryNoticeId).toBeNull()

    const after = await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })
    expect(after.status).toBe('SHOWING')

    const task = await prisma.task.findFirstOrThrow({
      where: { subjectType: 'Showing', subjectId: showing.id },
    })
    expect(task.type).toBe('escort_showing')

    const audited = await prisma.auditLog.findFirst({
      where: { action: 'showing.booked', entityId: showing.id },
    })
    expect(audited?.actorType).toBe('SYSTEM')
  })

  it('generates and serves the tenant entry notice for an occupied unit', async () => {
    const prospect = await seedProspect(occupiedListingId)
    const token = await tokenFor(prospect.id)
    const slots = await availableSlotsFor(
      { id: occupiedUnitId, status: 'OCCUPIED' },
      { state: 'TX', county: null, timezone: 'America/Chicago' },
      new Date(),
    )

    const formData = new FormData()
    formData.set('slot', slots[0]!.toISOString())
    const result = await bookShowing(token, {}, formData)
    expect(result.error).toBeUndefined()

    const showing = await prisma.showing.findFirstOrThrow({ where: { prospectId: prospect.id } })
    showingIds.push(showing.id)
    expect(showing.entryNoticeId).not.toBeNull()

    const notice = await prisma.notice.findUniqueOrThrow({ where: { id: showing.entryNoticeId! } })
    expect(notice.type).toBe('ENTRY_NOTICE')
    expect(notice.leaseId).toBe(leaseIds[0])

    const delivery = await prisma.noticeDelivery.findFirstOrThrow({ where: { noticeId: notice.id } })
    expect(delivery.method).toBe('PORTAL')

    const tenantNotification = await prisma.notification.findFirst({
      where: { recipientType: 'TENANT', recipientId: tenantId, templateKey: 'entry.notice' },
    })
    expect(tenantNotification).not.toBeNull()
  })

  it('refuses a second booking with the same link - the token is single-use', async () => {
    const prospect = await seedProspect(vacantListingId)
    const token = await tokenFor(prospect.id)
    const slots = await availableSlotsFor(
      { id: vacantUnitId, status: 'VACANT' },
      { state: 'TX', county: null, timezone: 'America/Chicago' },
      new Date(),
    )

    const formData = new FormData()
    formData.set('slot', slots[0]!.toISOString())
    await bookShowing(token, {}, formData)
    const showing = await prisma.showing.findFirstOrThrow({ where: { prospectId: prospect.id } })
    showingIds.push(showing.id)

    const second = await bookShowing(token, {}, formData)
    expect(second.error).toBeTruthy()

    const status = await showingLinkStatus(token)
    expect(status.ok).toBe(false)
    if (!status.ok) {
      expect(status.reason).toBe('already_used')
      expect(status.booked?.scheduledStart.getTime()).toBe(slots[0]!.getTime())
    }
  })

  it('refuses a slot another prospect already holds', async () => {
    const first = await seedProspect(vacantListingId)
    const firstToken = await tokenFor(first.id)
    const slots = await availableSlotsFor(
      { id: vacantUnitId, status: 'VACANT' },
      { state: 'TX', county: null, timezone: 'America/Chicago' },
      new Date(),
    )
    const chosen = slots[0]!

    const firstForm = new FormData()
    firstForm.set('slot', chosen.toISOString())
    await bookShowing(firstToken, {}, firstForm)
    const firstShowing = await prisma.showing.findFirstOrThrow({ where: { prospectId: first.id } })
    showingIds.push(firstShowing.id)

    const second = await seedProspect(vacantListingId)
    const secondToken = await tokenFor(second.id)
    const secondForm = new FormData()
    secondForm.set('slot', chosen.toISOString())
    const result = await bookShowing(secondToken, {}, secondForm)
    expect(result.error).toBeTruthy()

    const secondShowing = await prisma.showing.findFirst({ where: { prospectId: second.id } })
    expect(secondShowing).toBeNull()
  })
})

describe('sweepShowingReminders', () => {
  it('reminds a prospect whose showing starts in ~24h, and is idempotent within the same tick', async () => {
    const prospect = await seedProspect(vacantListingId)
    const start = new Date(Date.now() + 24 * 3_600_000)
    const showing = await prisma.showing.create({
      data: {
        propertyId,
        unitId: vacantUnitId,
        prospectId: prospect.id,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 30 * 60_000),
      },
    })
    showingIds.push(showing.id)

    const first = await sweepShowingReminders(new Date())
    expect(first.reminded).toBeGreaterThanOrEqual(1)

    // One row per template CHANNEL (SMS included, suppressed - no phone on
    // this fixture), not one per reminder - see notify()'s own comment on
    // why an unaddressable channel still writes a row. What matters here is
    // that a second tick does not grow the count.
    const countWhere = {
      recipientType: 'PROSPECT' as const,
      recipientId: prospect.id,
      templateKey: 'showing.scheduled',
    }
    const afterFirst = await prisma.notification.count({ where: countWhere })
    expect(afterFirst).toBeGreaterThan(0)

    // A second tick a moment later must not double-send - idempotencyKey is
    // keyed on the lead AND the showing.
    await sweepShowingReminders(new Date())
    const afterSecond = await prisma.notification.count({ where: countWhere })
    expect(afterSecond).toBe(afterFirst)
  })
})
