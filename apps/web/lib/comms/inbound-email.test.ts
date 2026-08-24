import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { receiveInboundMessage } from './messages.ts'

// Inbound email threading against a real database (COMM-08, R-097a).
//
// The address parsing and the quoted-tail stripping are proved in
// packages/core/comms/email-reply.test.ts. What needs a database is the part
// that decides WHOSE conversation this is - and the assertions worth having
// are the refusals, because a wrong match files one tenant's message into
// another's permanent record with an audit trail saying it was legitimate.

vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }))

let entityId: string
let propertyA: string
let propertyB: string
let unitA: string
let unitB: string
const tenantIds: string[] = []
const leaseIds: string[] = []
const threadIds: string[] = []

beforeEach(() => {
  process.env.INBOUND_EMAIL_ADDRESS = 'hello@inbound.example.test'
})

beforeAll(async () => {
  const stamp = `inmail-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const make = async (suffix: string) => {
    const property = await prisma.property.create({
      data: {
        legalEntityId: entityId,
        name: `${stamp}-${suffix}`,
        addressLine1: `${suffix} Inbox Way`,
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })
    const unit = await prisma.unit.create({
      data: { propertyId: property.id, name: `U-${suffix}`, status: 'OCCUPIED' },
    })
    return { propertyId: property.id, unitId: unit.id }
  }
  const a = await make('A')
  const b = await make('B')
  propertyA = a.propertyId
  propertyB = b.propertyId
  unitA = a.unitId
  unitB = b.unitId
})

afterAll(async () => {
  await prisma.unroutedMessage.deleteMany({ where: { fromAddress: { contains: 'inmail-' } } })
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.unit.deleteMany({ where: { id: { in: [unitA, unitB] } } })
  await prisma.property.updateMany({
    where: { id: { in: [propertyA, propertyB] } },
    data: { active: false },
  })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function tenantAt(propertyIds: readonly string[], email: string) {
  const tenant = await prisma.tenant.create({
    data: { firstName: 'In', lastName: `Box-${randomUUID().slice(0, 6)}`, email },
  })
  tenantIds.push(tenant.id)
  for (const propertyId of propertyIds) {
    const lease = await prisma.lease.create({
      data: {
        propertyId,
        unitId: propertyId === propertyA ? unitA : unitB,
        status: 'ACTIVE',
        startsOn: new Date('2026-01-01T00:00:00Z'),
        rentCents: 150_000,
      },
    })
    leaseIds.push(lease.id)
    await prisma.leaseTenant.create({
      data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
    })
  }
  return tenant
}

const inbound = (over: Partial<Parameters<typeof receiveInboundMessage>[0]> = {}) =>
  receiveInboundMessage({
    channel: 'EMAIL',
    from: 'nobody@example.test',
    body: 'The boiler is making a noise.',
    receivedAt: new Date(),
    externalId: `msg-${randomUUID()}`,
    ...over,
  })

describe('routing by From: address', () => {
  it('files a message from exactly one live tenant', async () => {
    const email = `one-${randomUUID().slice(0, 8)}@example.test`
    await tenantAt([propertyA], email)
    const result = await inbound({ from: email })
    expect(result.outcome).toBe('routed')
    if (result.outcome === 'routed') threadIds.push(result.threadId)
  })

  it('matches case-insensitively, because mail systems rewrite case', async () => {
    const email = `case-${randomUUID().slice(0, 8)}@example.test`
    await tenantAt([propertyA], email)
    const result = await inbound({ from: email.toUpperCase() })
    expect(result.outcome).toBe('routed')
  })

  it('REFUSES an unknown sender rather than guessing a property', async () => {
    const result = await inbound({ from: `stranger-${randomUUID().slice(0, 8)}@example.test` })
    expect(result).toMatchObject({ outcome: 'unrouted', reason: 'UNKNOWN_SENDER' })
  })

  it('REFUSES a tenant who is live at two properties', async () => {
    // The commonest real ambiguity, and picking one files "the tap is
    // dripping" against whichever house they signed for last.
    const email = `two-${randomUUID().slice(0, 8)}@example.test`
    await tenantAt([propertyA, propertyB], email)
    const result = await inbound({ from: email })
    expect(result).toMatchObject({ outcome: 'unrouted', reason: 'AMBIGUOUS' })
  })

  it('never matches on the subject line', async () => {
    // Subject-based threading is how mail systems put an unrelated
    // "Re: Maintenance" into somebody else's conversation.
    const email = `subj-${randomUUID().slice(0, 8)}@example.test`
    await tenantAt([propertyA], email)
    const routed = await inbound({ from: email })
    expect(routed.outcome).toBe('routed')
    const stranger = await inbound({ from: `other-${randomUUID().slice(0, 6)}@example.test` })
    expect(stranger.outcome).toBe('unrouted')
  })
})

describe('routing by reply key', () => {
  it('resolves the ambiguity that From: alone cannot', async () => {
    // A tenant live at two properties is unroutable by address. The key
    // names the conversation, so the reply lands where it belongs - which is
    // the entire reason the key exists.
    const email = `key-${randomUUID().slice(0, 8)}@example.test`
    const tenant = await tenantAt([propertyA, propertyB], email)
    expect((await inbound({ from: email })).outcome).toBe('unrouted')

    const thread = await prisma.thread.create({
      data: {
        key: `tenant:${tenant.id}:property:${propertyA}:${randomUUID().slice(0, 6)}`,
        propertyId: propertyA,
        tenantId: tenant.id,
        replyKey: randomUUID().replace(/-/g, '').slice(0, 24),
      },
    })
    threadIds.push(thread.id)

    const result = await inbound({
      from: email,
      recipients: [`hello+${thread.replyKey}@inbound.example.test`],
    })
    expect(result).toMatchObject({ outcome: 'routed', threadId: thread.id })
  })

  it('falls through to From: matching when the key names no thread', async () => {
    // A deleted conversation, a forwarded old email, a tag a corporate mail
    // system mangled. None of them should lose the message.
    const email = `stale-${randomUUID().slice(0, 8)}@example.test`
    await tenantAt([propertyA], email)
    const result = await inbound({
      from: email,
      recipients: ['hello+deadbeefdeadbeefdeadbeef@inbound.example.test'],
    })
    expect(result.outcome).toBe('routed')
  })

  it('ignores a key addressed to somebody else’s domain', async () => {
    const email = `spoof-${randomUUID().slice(0, 8)}@example.test`
    const tenant = await tenantAt([propertyA, propertyB], email)
    const thread = await prisma.thread.create({
      data: {
        key: `tenant:${tenant.id}:property:${propertyA}:${randomUUID().slice(0, 6)}`,
        propertyId: propertyA,
        tenantId: tenant.id,
        replyKey: randomUUID().replace(/-/g, '').slice(0, 24),
      },
    })
    threadIds.push(thread.id)
    const result = await inbound({
      from: email,
      recipients: [`hello+${thread.replyKey}@lookalike.example.test`],
    })
    // Back to being ambiguous, which is the correct answer.
    expect(result).toMatchObject({ outcome: 'unrouted', reason: 'AMBIGUOUS' })
  })
})

describe('duplicates', () => {
  it('treats a provider redelivery as a no-op', async () => {
    const email = `dupe-${randomUUID().slice(0, 8)}@example.test`
    await tenantAt([propertyA], email)
    const externalId = `msg-${randomUUID()}`
    expect((await inbound({ from: email, externalId })).outcome).toBe('routed')
    expect((await inbound({ from: email, externalId })).outcome).toBe('duplicate')
  })
})
