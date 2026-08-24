import { randomUUID } from 'node:crypto'
import { openSecret } from '@rental/core/auth'
import { accessWindow } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SimulatedSmartLockAdapter } from '@/lib/locks/simulated-adapter.ts'
import { smartLockAdapter } from '@/lib/locks/provider.ts'
import { verifyIdentityForShowing } from './access-actions.ts'
import { showingAccessLinkStatus } from './access-link.ts'
import { revokeShowingAccessFor } from './revoke.ts'

// The database half of the self-showing (LEASE-08, R-094).
//
// EVERYTHING THAT TOUCHES THE DEVICE LIVES HERE, not in the e2e, and the
// reason is simply where the simulator is: it holds the lock's codes and its
// event log in the server process, so a browser test can drive the pages but
// can never make somebody type a code at a door. The decision logic is
// proved in packages/core/scheduling/self-showing.test.ts; the pages are
// proved in e2e/self-showing.spec.ts; this is the seam between them.

vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))

const lockAdapter = smartLockAdapter as SimulatedSmartLockAdapter

let propertyId: string
let unitId: string
let listingId: string
let lockExternalId: string
let smartLockId: string
const prospectIds: string[] = []
const showingIds: string[] = []
let entityId: string

beforeAll(async () => {
  const stamp = `selfshow-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '11 Lockbox Lane',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
      yearBuilt: 2015,
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({
    data: { propertyId, name: `${stamp}-U`, status: 'VACANT' },
  })
  unitId = unit.id
  const listing = await prisma.listing.create({
    data: {
      propertyId,
      unitId,
      status: 'PUBLISHED',
      rentCents: 150_000,
      availableOn: new Date('2026-09-01'),
      publishedAt: new Date(),
    },
  })
  listingId = listing.id
  lockExternalId = `dev-${stamp}`
  const lock = await prisma.smartLock.create({
    data: { unitId, externalId: lockExternalId, label: 'Front door keypad' },
  })
  smartLockId = lock.id
})

afterAll(async () => {
  await prisma.lockEvent.deleteMany({ where: { smartLockId } })
  await prisma.showingAccess.deleteMany({ where: { smartLockId } })
  await prisma.showing.deleteMany({ where: { id: { in: showingIds } } })
  await prisma.identityCheck.deleteMany({ where: { prospectId: { in: prospectIds } } })
  await prisma.authToken.deleteMany({ where: { subjectId: { in: showingIds } } })
  await prisma.smartLock.deleteMany({ where: { id: smartLockId } })
  await prisma.prospect.deleteMany({ where: { id: { in: prospectIds } } })
  await prisma.listing.deleteMany({ where: { id: listingId } })
  await prisma.unit.deleteMany({ where: { id: unitId } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

/// A booked showing whose slot is happening right now, plus its access
/// token - the state the prospect's link arrives in.
async function bookedNow(name: { first: string; last: string }) {
  const prospect = await prisma.prospect.create({
    data: {
      propertyId,
      listingId,
      firstName: name.first,
      lastName: name.last,
      email: `${randomUUID().slice(0, 8)}@example.test`,
      source: 'TEST',
      status: 'SHOWING',
    },
  })
  prospectIds.push(prospect.id)
  const start = new Date()
  const showing = await prisma.showing.create({
    data: {
      propertyId,
      unitId,
      prospectId: prospect.id,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 30 * 60_000),
    },
  })
  showingIds.push(showing.id)

  const { mintToken } = await import('@rental/core/auth')
  const minted = mintToken('SHOWING_ACCESS')
  await prisma.authToken.create({
    data: {
      purpose: 'SHOWING_ACCESS',
      tokenHash: minted.tokenHash,
      subjectType: 'Showing',
      subjectId: showing.id,
      expiresAt: minted.expiresAt,
    },
  })
  return { prospect, showing, token: minted.token }
}

function form(documentName: string): FormData {
  const data = new FormData()
  data.set('documentName', documentName)
  return data
}

describe('verifying and issuing', () => {
  it('issues a code, and the code the LOCK holds is the code the prospect is shown', async () => {
    const { showing, token } = await bookedNow({ first: 'Ada', last: 'Lovelace' })
    const state = await verifyIdentityForShowing(token, {}, form('Ada B. Lovelace'))
    expect(state.error).toBeUndefined()

    const access = await prisma.showingAccess.findUniqueOrThrow({
      where: { showingId: showing.id },
      include: { identityCheck: true },
    })
    expect(access.identityCheck.result).toBe('VERIFIED')
    // The middle initial is not a different person, and refusing on one
    // would send every second prospect to a phone call.
    expect(access.identityCheck.documentName).toBe('Ada B. Lovelace')
    expect(access).toMatchObject(accessWindow(showing))

    // The one assertion that catches a code being minted on our side and
    // never reaching the device: the door has to hold the same digits.
    const code = openSecret(access.sealedCode, 'access-code')!
    const event = lockAdapter.simulateEntry({
      externalId: lockExternalId,
      code,
      at: new Date(),
    })
    expect(event.kind).toBe('UNLOCKED')
  })

  it('refuses a document in somebody else’s name, and keeps the attempt', async () => {
    const { showing, token } = await bookedNow({ first: 'Grace', last: 'Hopper' })
    const state = await verifyIdentityForShowing(token, {}, form('Charles Babbage'))
    expect(state.error).toContain('does not match')

    expect(await prisma.showingAccess.findUnique({ where: { showingId: showing.id } })).toBeNull()
    const check = await prisma.identityCheck.findFirstOrThrow({
      where: { prospectId: showing.prospectId },
    })
    // The attempt is a row, not a silence. "How many times did somebody try,
    // and under what names" is the question this exists to answer.
    expect(check.result).toBe('NAME_MISMATCH')
    expect(check.documentName).toBe('Charles Babbage')
  })

  it('will not issue a second code for one viewing', async () => {
    const { showing, token } = await bookedNow({ first: 'Alan', last: 'Turing' })
    await verifyIdentityForShowing(token, {}, form('Alan Turing'))
    const again = await verifyIdentityForShowing(token, {}, form('Alan Turing'))
    expect(again.notice).toContain('already confirmed')
    expect(
      await prisma.showingAccess.count({ where: { showingId: showing.id } }),
    ).toBe(1)
  })

  it('refuses outright once the unit is let, without calling the provider', async () => {
    const { showing, token } = await bookedNow({ first: 'Katherine', last: 'Johnson' })
    await prisma.unit.update({ where: { id: unitId }, data: { status: 'OCCUPIED' } })
    try {
      const state = await verifyIdentityForShowing(token, {}, form('Katherine Johnson'))
      expect(state.error).toContain('do not go in')
      // Nothing reached a third party, and no check row exists to say a
      // stranger's ID was sent anywhere.
      expect(
        await prisma.identityCheck.count({ where: { prospectId: showing.prospectId } }),
      ).toBe(0)
    } finally {
      await prisma.unit.update({ where: { id: unitId }, data: { status: 'VACANT' } })
    }
  })
})

describe('the instant kill', () => {
  it('stops the door, not just the page', async () => {
    const { showing, token } = await bookedNow({ first: 'Mary', last: 'Jackson' })
    await verifyIdentityForShowing(token, {}, form('Mary Jackson'))
    const access = await prisma.showingAccess.findUniqueOrThrow({
      where: { showingId: showing.id },
    })
    const code = openSecret(access.sealedCode, 'access-code')!
    expect(lockAdapter.simulateEntry({ externalId: lockExternalId, code, at: new Date() }).kind)
      .toBe('UNLOCKED')

    const outcome = await revokeShowingAccessFor(showing.id, {
      reason: 'The house was let this morning.',
      staffId: null,
    })
    expect(outcome).toEqual({ reachedDevice: true })

    // THE POINT OF THE WHOLE FILE. Our page refusing to display the code is
    // the second lock; this is the first.
    expect(lockAdapter.simulateEntry({ externalId: lockExternalId, code, at: new Date() }).kind)
      .toBe('DENIED')

    const link = await showingAccessLinkStatus(token)
    expect(link.ok && link.access?.revokedAt).toBeTruthy()
  })

  it('is idempotent, because a second press must never fail', async () => {
    const { showing, token } = await bookedNow({ first: 'Dorothy', last: 'Vaughan' })
    await verifyIdentityForShowing(token, {}, form('Dorothy Vaughan'))
    await revokeShowingAccessFor(showing.id, { reason: 'first', staffId: null })
    // Null rather than an error: there is nothing live left to pull.
    expect(await revokeShowingAccessFor(showing.id, { reason: 'second', staffId: null })).toBeNull()
    const access = await prisma.showingAccess.findUniqueOrThrow({
      where: { showingId: showing.id },
    })
    // The FIRST reason stands. A second press must not overwrite why it was
    // actually pulled.
    expect(access.revokedReason).toBe('first')
  })
})

describe('the entry log', () => {
  it('records what the device says, including an entry no code of ours explains', async () => {
    const { showing, token } = await bookedNow({ first: 'Annie', last: 'Easley' })
    await verifyIdentityForShowing(token, {}, form('Annie Easley'))
    const access = await prisma.showingAccess.findUniqueOrThrow({
      where: { showingId: showing.id },
    })
    const code = openSecret(access.sealedCode, 'access-code')!

    const at = new Date()
    lockAdapter.simulateEntry({ externalId: lockExternalId, code, at })
    lockAdapter.simulateEntry({ externalId: lockExternalId, code: '000000', at })
    lockAdapter.simulateUnknownEntry({ externalId: lockExternalId, at, label: 'Owner key fob' })

    const events = await lockAdapter.events({
      externalId: lockExternalId,
      since: new Date(at.getTime() - 60_000),
    })
    // A refused attempt is as much of the log as a successful one: a run of
    // them at a door at 11pm is the thing somebody wants to see.
    expect(events.filter((event) => event.kind === 'DENIED').length).toBeGreaterThan(0)
    // And the entry we cannot explain is present rather than dropped - the
    // one an entry log is actually worth keeping for, and the one a log
    // assembled from our own records could never show (D-27).
    expect(
      events.some((event) => event.codeProviderRef === null && event.actorLabel === 'Owner key fob'),
    ).toBe(true)
  })
})
