import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  logCall,
  receiveInboundMessage,
  routeUnroutedMessage,
  sendThreadMessage,
} from './messages.ts'
import { resolveThread } from './threads.ts'

// Threading and inbound routing against a real database (COMM-01, R-017).
//
// The routing tests are the point of this file. `decideRoute`'s rules are
// unit-tested pure; what cannot be proved that way is that the CANDIDATE
// LOOKUP feeding it finds the right people - that a former tenant's number is
// not matched, that a couple sharing a handset really does produce two
// candidates, and that two texts arriving together produce one thread rather
// than two. Each of those failures is a cross-tenant leak or a split history.

const CHICAGO = 'America/Chicago'

let entityId: string
let propertyA: string
let propertyB: string
let staffId: string

const tenantIds: string[] = []
const threadIds: string[] = []
const unroutedIds: string[] = []

async function makeTenant(args: {
  phone?: string | null
  propertyId: string
  active?: boolean
  startsOn?: Date
}) {
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Test',
      lastName: randomUUID().slice(0, 8),
      phone: args.phone ?? null,
      active: args.active ?? true,
    },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: args.propertyId,
      unitId: (
        await prisma.unit.create({
          data: {
            propertyId: args.propertyId,
            name: `U-${randomUUID().slice(0, 6)}`,
            status: 'OCCUPIED',
          },
        })
      ).id,
      status: 'ACTIVE',
      startsOn: args.startsOn ?? new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id },
  })
  return tenant
}

beforeAll(async () => {
  const stamp = `comms-${Date.now()}`
  const entity = await prisma.legalEntity.create({
    data: { name: stamp, type: 'LLC' },
  })
  entityId = entity.id

  const make = async (name: string) =>
    prisma.property.create({
      data: {
        legalEntityId: entityId,
        name: `${stamp}-${name}`,
        addressLine1: '1 Test St',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: CHICAGO,
        propertyType: 'SINGLE_FAMILY',
      },
    })
  propertyA = (await make('a')).id
  propertyB = (await make('b')).id

  const staff = await prisma.staffUser.create({
    data: { email: `${stamp}@example.test`, name: 'Comms Test' },
  })
  staffId = staff.id
})

afterAll(async () => {
  // UnroutedMessage has a lifecycle and is NOT trigger-protected, so unlike
  // Message it can and MUST be cleaned up: the triage list is deliberately
  // unscoped (an unrouted message has no property to scope it by), so rows
  // left here surface in the /messages/unrouted e2e assertions.
  await prisma.unroutedMessage.deleteMany({ where: { id: { in: unroutedIds } } })

  // Message is append-only, so nothing written here can be deleted. The
  // properties and tenants that carry them are deactivated instead - the same
  // wall AuditLog already puts up, handled the same way in every spec.
  await prisma.unroutedMessage.updateMany({
    where: { routedByStaffId: staffId },
    data: { routedByStaffId: null },
  })
  await prisma.property.updateMany({
    where: { id: { in: [propertyA, propertyB] } },
    data: { active: false },
  })
  await prisma.tenant.updateMany({
    where: { id: { in: tenantIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

describe('thread resolution', () => {
  it('returns the same thread for the same participant', async () => {
    const tenant = await makeTenant({ propertyId: propertyA })
    const first = await resolveThread({
      scope: 'TENANT',
      propertyId: propertyA,
      tenantId: tenant.id,
    })
    const second = await resolveThread({
      scope: 'TENANT',
      propertyId: propertyA,
      tenantId: tenant.id,
    })
    threadIds.push(first.id)
    expect(second.id).toBe(first.id)
  })

  it('creates exactly one thread when five callers race', async () => {
    // Two texts arriving together must not split somebody's history in half.
    const tenant = await makeTenant({ propertyId: propertyA })
    const identity = {
      scope: 'TENANT' as const,
      propertyId: propertyA,
      tenantId: tenant.id,
    }
    const results = await Promise.all(
      Array.from({ length: 5 }, () => resolveThread(identity)),
    )
    const ids = new Set(results.map((thread) => thread.id))
    expect(ids.size).toBe(1)
    threadIds.push(...ids)

    const stored = await prisma.thread.count({ where: { tenantId: tenant.id } })
    expect(stored).toBe(1)
  })
})

describe('inbound routing', () => {
  it('files a text from a known tenant into their thread', async () => {
    const phone = '+15125550001'
    const tenant = await makeTenant({ phone, propertyId: propertyA })

    const result = await receiveInboundMessage({
      channel: 'SMS',
      from: '(512) 555-0001',
      body: 'The kitchen tap is dripping',
      receivedAt: new Date('2026-08-05T15:00:00Z'),
    })

    expect(result.outcome).toBe('routed')
    if (result.outcome !== 'routed') return
    threadIds.push(result.threadId)

    const thread = await prisma.thread.findUniqueOrThrow({
      where: { id: result.threadId },
    })
    expect(thread.tenantId).toBe(tenant.id)
    expect(thread.propertyId).toBe(propertyA)
    // The inbox sorts on this, and it must reflect the message just filed.
    expect(thread.lastMessageAt?.toISOString()).toBe('2026-08-05T15:00:00.000Z')

    const message = await prisma.message.findUniqueOrThrow({
      where: { id: result.messageId },
      include: { delivery: true },
    })
    expect(message.direction).toBe('INBOUND')
    expect(message.tenantId).toBe(tenant.id)
    expect(message.delivery?.status).toBe('DELIVERED')
  })

  it('records an unknown number instead of guessing or dropping it', async () => {
    const result = await receiveInboundMessage({
      channel: 'SMS',
      from: '+15125559999',
      body: 'wrong number probably',
      receivedAt: new Date('2026-08-05T15:05:00Z'),
    })

    expect(result).toMatchObject({
      outcome: 'unrouted',
      reason: 'UNKNOWN_SENDER',
    })
    if (result.outcome !== 'unrouted') return
    unroutedIds.push(result.unroutedId)
    const row = await prisma.unroutedMessage.findUniqueOrThrow({
      where: { id: result.unroutedId },
    })
    // Dropping it is the one outcome that is never acceptable.
    expect(row.body).toBe('wrong number probably')
    expect(row.fromAddress).toBe('+15125559999')
  })

  it('refuses to pick between two tenants sharing a phone', async () => {
    // A couple with one handset. Filing under either one puts a conversation
    // in the wrong person's permanent record.
    const phone = '+15125550002'
    await makeTenant({ phone, propertyId: propertyA })
    await makeTenant({ phone, propertyId: propertyA })

    const result = await receiveInboundMessage({
      channel: 'SMS',
      from: phone,
      body: 'Which of us is this?',
      receivedAt: new Date('2026-08-05T15:10:00Z'),
    })

    expect(result).toMatchObject({ outcome: 'unrouted', reason: 'AMBIGUOUS' })
    if (result.outcome === 'unrouted') unroutedIds.push(result.unroutedId)
    const threads = await prisma.thread.count({
      where: { propertyId: propertyA, tenant: { phone } },
    })
    expect(threads).toBe(0)
  })

  it('ignores an inactive tenant, so a reassigned number is not misfiled', async () => {
    // Phone numbers get recycled. Matching a former tenant's number would
    // file a stranger's text into a closed tenancy's record.
    const phone = '+15125550003'
    await makeTenant({ phone, propertyId: propertyA, active: false })

    const result = await receiveInboundMessage({
      channel: 'SMS',
      from: phone,
      body: 'hello?',
      receivedAt: new Date('2026-08-05T15:15:00Z'),
    })
    expect(result).toMatchObject({
      outcome: 'unrouted',
      reason: 'UNKNOWN_SENDER',
    })
    if (result.outcome === 'unrouted') unroutedIds.push(result.unroutedId)
  })

  it('refuses an unparseable sender', async () => {
    const result = await receiveInboundMessage({
      channel: 'SMS',
      from: 'UNKNOWN',
      body: 'from a blocked number',
      receivedAt: new Date('2026-08-05T15:20:00Z'),
    })
    expect(result).toMatchObject({
      outcome: 'unrouted',
      reason: 'UNKNOWN_SENDER',
    })
  })

  it('treats a redelivered webhook as a duplicate', async () => {
    // Providers retry. A redelivery must not put a second copy of the same
    // text in somebody's history.
    const phone = '+15125550004'
    await makeTenant({ phone, propertyId: propertyA })
    const externalId = `SM${randomUUID()}`

    const first = await receiveInboundMessage({
      channel: 'SMS',
      from: phone,
      body: 'only once please',
      receivedAt: new Date('2026-08-05T15:25:00Z'),
      externalId,
    })
    expect(first.outcome).toBe('routed')
    if (first.outcome === 'routed') threadIds.push(first.threadId)

    const second = await receiveInboundMessage({
      channel: 'SMS',
      from: phone,
      body: 'only once please',
      receivedAt: new Date('2026-08-05T15:25:00Z'),
      externalId,
    })
    expect(second).toEqual({ outcome: 'duplicate' })

    const count = await prisma.message.count({ where: { externalId } })
    expect(count).toBe(1)
  })

  it('refuses a tenant holding two concurrent leases at different properties', async () => {
    // Genuinely ambiguous: "the tap is dripping" - which house? Picking the
    // newer lease would file a guess as a fact, and the property is what
    // every RBAC check keys on.
    const phone = '+15125550005'
    const tenant = await makeTenant({
      phone,
      propertyId: propertyA,
      startsOn: new Date('2026-01-01'),
    })
    const unit = await prisma.unit.create({
      data: {
        propertyId: propertyB,
        name: `U-${randomUUID().slice(0, 6)}`,
        status: 'OCCUPIED',
      },
    })
    const lease = await prisma.lease.create({
      data: {
        propertyId: propertyB,
        unitId: unit.id,
        status: 'ACTIVE',
        startsOn: new Date('2026-06-01'),
        rentCents: 100_000,
      },
    })
    await prisma.leaseTenant.create({
      data: { leaseId: lease.id, tenantId: tenant.id },
    })

    const result = await receiveInboundMessage({
      channel: 'SMS',
      from: phone,
      body: 'which house is this about?',
      receivedAt: new Date('2026-08-05T15:30:00Z'),
    })
    expect(result).toMatchObject({ outcome: 'unrouted', reason: 'AMBIGUOUS' })
    if (result.outcome === 'unrouted') unroutedIds.push(result.unroutedId)
  })

  it('routes a tenant who MOVED within the portfolio to their current home', async () => {
    // The common case, and the reason the lookup filters to live leases: an
    // ended tenancy at the old address must not make every future text
    // ambiguous forever.
    const phone = '+15125550006'
    const tenant = await makeTenant({
      phone,
      propertyId: propertyB,
      startsOn: new Date('2026-06-01'),
    })
    const oldUnit = await prisma.unit.create({
      data: {
        propertyId: propertyA,
        name: `U-${randomUUID().slice(0, 6)}`,
        status: 'VACANT',
      },
    })
    const endedLease = await prisma.lease.create({
      data: {
        propertyId: propertyA,
        unitId: oldUnit.id,
        status: 'ENDED',
        startsOn: new Date('2025-01-01'),
        endsOn: new Date('2026-05-31'),
        rentCents: 90_000,
      },
    })
    await prisma.leaseTenant.create({
      data: { leaseId: endedLease.id, tenantId: tenant.id },
    })

    const result = await receiveInboundMessage({
      channel: 'SMS',
      from: phone,
      body: 'porch light is out',
      receivedAt: new Date('2026-08-05T15:35:00Z'),
    })
    expect(result.outcome).toBe('routed')
    if (result.outcome !== 'routed') return
    threadIds.push(result.threadId)
    const thread = await prisma.thread.findUniqueOrThrow({
      where: { id: result.threadId },
    })
    expect(thread.propertyId).toBe(propertyB)
  })
})

describe('filing an unrouted message', () => {
  it('preserves the original receipt time in the transcript', async () => {
    const tenant = await makeTenant({ propertyId: propertyA })
    const received = new Date('2026-08-05T09:00:00Z')

    const inbound = await receiveInboundMessage({
      channel: 'SMS',
      from: '+15125558888',
      body: 'sorted out later',
      receivedAt: received,
    })
    expect(inbound.outcome).toBe('unrouted')
    if (inbound.outcome !== 'unrouted') return
    unroutedIds.push(inbound.unroutedId)

    const thread = await resolveThread({
      scope: 'TENANT',
      propertyId: propertyA,
      tenantId: tenant.id,
    })
    threadIds.push(thread.id)

    const message = await routeUnroutedMessage({
      unroutedId: inbound.unroutedId,
      threadId: thread.id,
      staffUserId: staffId,
    })

    // The transcript has to read in the order things happened, not the order
    // somebody got around to sorting them out.
    expect(message?.sentAt.toISOString()).toBe(received.toISOString())

    const row = await prisma.unroutedMessage.findUniqueOrThrow({
      where: { id: inbound.unroutedId },
    })
    expect(row.routedMessageId).toBe(message?.id)
    expect(row.routedByStaffId).toBe(staffId)
  })

  it('files once when two people triage the same item', async () => {
    const tenant = await makeTenant({ propertyId: propertyA })
    const inbound = await receiveInboundMessage({
      channel: 'SMS',
      from: '+15125558887',
      body: 'double filed?',
      receivedAt: new Date('2026-08-05T09:05:00Z'),
    })
    if (inbound.outcome !== 'unrouted') throw new Error('expected unrouted')
    unroutedIds.push(inbound.unroutedId)

    const thread = await resolveThread({
      scope: 'TENANT',
      propertyId: propertyA,
      tenantId: tenant.id,
    })
    threadIds.push(thread.id)

    const attempts = await Promise.allSettled([
      routeUnroutedMessage({
        unroutedId: inbound.unroutedId,
        threadId: thread.id,
        staffUserId: staffId,
      }),
      routeUnroutedMessage({
        unroutedId: inbound.unroutedId,
        threadId: thread.id,
        staffUserId: staffId,
      }),
    ])
    const succeeded = attempts.filter((a) => a.status === 'fulfilled' && a.value)
    expect(succeeded).toHaveLength(1)

    const filed = await prisma.message.count({
      where: { threadId: thread.id, body: 'double filed?' },
    })
    expect(filed).toBe(1)
  })
})

describe('outbound and call logging', () => {
  it('records an outbound message before it is transmitted', async () => {
    const tenant = await makeTenant({
      phone: '+15125550777',
      propertyId: propertyA,
    })
    const thread = await resolveThread({
      scope: 'TENANT',
      propertyId: propertyA,
      tenantId: tenant.id,
    })
    threadIds.push(thread.id)

    const message = await sendThreadMessage({
      threadId: thread.id,
      channel: 'SMS',
      body: 'Tech arrives between 9 and 11',
      staffUserId: staffId,
      toAddress: '+15125550777',
    })

    const stored = await prisma.message.findUniqueOrThrow({
      where: { id: message.id },
      include: { delivery: true },
    })
    expect(stored.direction).toBe('OUTBOUND')
    // Staff attribution on every outbound row - COMM-01 asks for exactly this.
    expect(stored.staffUserId).toBe(staffId)
    expect(stored.delivery?.status).toBe('SENT')
    expect(stored.delivery?.externalId).toMatch(/^log_/)
  })

  it('suppresses an outbound message while the kill switch is on', async () => {
    const previous = process.env.NOTIFICATIONS_ENABLED
    process.env.NOTIFICATIONS_ENABLED = 'false'
    try {
      const tenant = await makeTenant({
        phone: '+15125550778',
        propertyId: propertyA,
      })
      const thread = await resolveThread({
        scope: 'TENANT',
        propertyId: propertyA,
        tenantId: tenant.id,
      })
      threadIds.push(thread.id)

      const message = await sendThreadMessage({
        threadId: thread.id,
        channel: 'SMS',
        body: 'should not go out',
        staffUserId: staffId,
        toAddress: '+15125550778',
      })
      const stored = await prisma.messageDelivery.findFirstOrThrow({
        where: { messageId: message.id },
      })
      // The kill switch covers conversation messages too, not just automated
      // notifications - that is why both paths share deliverOverChannel.
      expect(stored.status).toBe('SUPPRESSED')
      expect(stored.failureCode).toBe('kill_switch')
    } finally {
      if (previous === undefined) delete process.env.NOTIFICATIONS_ENABLED
      else process.env.NOTIFICATIONS_ENABLED = previous
    }
  })

  it('does not jump a thread to the top of the inbox for an old call', async () => {
    const tenant = await makeTenant({ propertyId: propertyA })
    const thread = await resolveThread({
      scope: 'TENANT',
      propertyId: propertyA,
      tenantId: tenant.id,
    })
    threadIds.push(thread.id)

    await sendThreadMessage({
      threadId: thread.id,
      channel: 'PORTAL',
      body: 'recent',
      staffUserId: staffId,
      toAddress: null,
      sentAt: new Date('2026-08-05T12:00:00Z'),
    })
    await logCall({
      threadId: thread.id,
      body: 'wrote this up late',
      staffUserId: staffId,
      occurredAt: new Date('2026-08-01T09:00:00Z'),
    })

    const stored = await prisma.thread.findUniqueOrThrow({
      where: { id: thread.id },
    })
    expect(stored.lastMessageAt?.toISOString()).toBe(
      '2026-08-05T12:00:00.000Z',
    )
  })

  it('stores a call note with the call time, not the typing time', async () => {
    const tenant = await makeTenant({ propertyId: propertyA })
    const thread = await resolveThread({
      scope: 'TENANT',
      propertyId: propertyA,
      tenantId: tenant.id,
    })
    threadIds.push(thread.id)

    const occurredAt = new Date('2026-08-04T16:20:00Z')
    const message = await logCall({
      threadId: thread.id,
      body: 'Agreed Tuesday 9am',
      staffUserId: staffId,
      occurredAt,
    })

    const stored = await prisma.message.findUniqueOrThrow({
      where: { id: message.id },
    })
    expect(stored.channel).toBe('CALL_LOG')
    expect(stored.sentAt.toISOString()).toBe(occurredAt.toISOString())
    // createdAt records separately when it was typed - the pair is what makes
    // the note contemporaneous rather than reconstructed.
    expect(stored.createdAt.getTime()).toBeGreaterThan(occurredAt.getTime())
  })
})
