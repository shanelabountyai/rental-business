import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPreferences } from '@/lib/notifications/queries.ts'
import { honourEmailOptOut } from './email-opt-out.ts'
import { handleInboundEmail } from './email-intake.ts'
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
const documentIds: string[] = []
const ticketIds: string[] = []

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
  await prisma.notificationPreference.deleteMany({
    where: { recipientType: 'TENANT', recipientId: { in: tenantIds } },
  })
  await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
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

describe('attachments (R-097d)', () => {
  const photo = (over: Partial<{ fileName: string; contentType: string; bytes: number }> = {}) => ({
    fileName: over.fileName ?? 'leak.jpg',
    contentType: over.contentType ?? 'image/jpeg',
    content: Buffer.alloc(over.bytes ?? 2048, 7),
  })

  it('keeps a photograph a tenant emailed, on the message it arrived with', async () => {
    // R-097a filed the words and threw the photograph away, silently.
    const email = `photo-${randomUUID().slice(0, 8)}@example.test`
    const tenant = await tenantAt([propertyA], email)
    const result = await inbound({ from: email, attachments: [photo()] })
    expect(result.outcome).toBe('routed')
    if (result.outcome !== 'routed') return

    const documents = await prisma.document.findMany({ where: { messageId: result.messageId } })
    expect(documents).toHaveLength(1)
    expect(documents[0]).toMatchObject({
      propertyId: propertyA,
      tenantId: tenant.id,
      // The same type R-019 gives a photo arriving through the portal: it is
      // the same evidence whichever way it was sent.
      type: 'MAINTENANCE_PHOTO',
      fileName: 'leak.jpg',
    })
    documentIds.push(documents[0]!.id)
  })

  it('refuses a type nobody sends on purpose, and keeps the message anyway', async () => {
    // A closed list, not a block list - and the words are already recorded by
    // the time an attachment is judged.
    const email = `exe-${randomUUID().slice(0, 8)}@example.test`
    await tenantAt([propertyA], email)
    const result = await inbound({
      from: email,
      attachments: [photo({ fileName: 'invoice.pdf.exe', contentType: 'application/x-msdownload' })],
    })
    expect(result.outcome).toBe('routed')
    if (result.outcome !== 'routed') return
    expect(await prisma.document.count({ where: { messageId: result.messageId } })).toBe(0)
    const message = await prisma.message.findUniqueOrThrow({ where: { id: result.messageId } })
    expect(message.body).toContain('boiler')
  })

  it('refuses one that is too big', async () => {
    const email = `big-${randomUUID().slice(0, 8)}@example.test`
    await tenantAt([propertyA], email)
    const result = await inbound({
      from: email,
      attachments: [photo({ bytes: 16 * 1024 * 1024 })],
    })
    expect(result.outcome).toBe('routed')
    if (result.outcome !== 'routed') return
    expect(await prisma.document.count({ where: { messageId: result.messageId } })).toBe(0)
  })

  it('RECORDS what it dropped when the message could not be routed', async () => {
    // The half it would be easy to leave broken: an unrouted message has no
    // property to hang a Document on, and silently discarding is the exact
    // defect this item exists to fix.
    const result = await inbound({
      from: `nobody-${randomUUID().slice(0, 8)}@example.test`,
      attachments: [photo(), photo({ fileName: 'second.png', contentType: 'image/png' })],
    })
    expect(result.outcome).toBe('unrouted')
    if (result.outcome !== 'unrouted') return
    const row = await prisma.unroutedMessage.findUniqueOrThrow({
      where: { id: result.unroutedId },
    })
    expect(row.attachmentsDropped).toBe(2)
  })
})

describe('"stop emailing me" (R-097e)', () => {
  it('switches off what it can and leaves the locked categories alone', async () => {
    const email = `optout-${randomUUID().slice(0, 8)}@example.test`
    const tenant = await tenantAt([propertyA], email)
    const outcome = await honourEmailOptOut('TENANT', tenant.id, email)

    expect(outcome.stopped).toBeGreaterThan(0)
    const stored = await prisma.notificationPreference.findMany({
      where: { recipientType: 'TENANT', recipientId: tenant.id, channel: 'EMAIL' },
    })
    expect(stored.length).toBe(outcome.stopped)
    expect(stored.every((row) => row.enabled === false)).toBe(true)

    // THE HALF THAT MATTERS. A legal notice that did not arrive is a notice
    // that was not served, and an entry notice is an obligation of ours
    // rather than a subscription of theirs - so no preference row exists to
    // turn them off, and `getPreferences` reports them on regardless.
    const categories = new Set(stored.map((row) => row.category))
    for (const locked of ['legal_notice', 'entry_notice', 'maintenance_emergency']) {
      expect(categories.has(locked), locked).toBe(false)
    }
    expect(outcome.stillSending).toContain('Entry notices')

    const effective = await getPreferences('TENANT', tenant.id)
    const emailRows = effective.filter((row) => row.channel === 'EMAIL')
    expect(emailRows.filter((row) => row.locked).every((row) => row.enabled)).toBe(true)
    expect(emailRows.filter((row) => !row.locked).every((row) => !row.enabled)).toBe(true)
  })

  it('keeps the message in the conversation rather than swallowing it', async () => {
    // R-040e's rule for a `STOP` text, applied here: the tenant did send it,
    // it is part of their record, and an evidence trail that quietly drops
    // the one message that changed what we may send them is not one.
    const email = `keep-${randomUUID().slice(0, 8)}@example.test`
    await tenantAt([propertyA], email)
    const result = await inbound({ from: email, body: 'Please stop emailing me.' })
    expect(result.outcome).toBe('routed')
    if (result.outcome !== 'routed') return
    const message = await prisma.message.findUniqueOrThrow({ where: { id: result.messageId } })
    expect(message.body).toBe('Please stop emailing me.')
  })
})

describe('email-to-ticket (R-097f)', () => {
  const emailFrom = (over: Partial<Parameters<typeof handleInboundEmail>[0]> = {}) =>
    handleInboundEmail({
      from: 'nobody@example.test',
      body: 'The boiler is making a noise.',
      receivedAt: new Date(),
      externalId: `msg-${randomUUID()}`,
      hasReplyKey: false,
      ...over,
    })

  it('opens a ticket for an unprompted email, as SMS already does for a text', async () => {
    const email = `ticket-${randomUUID().slice(0, 8)}@example.test`
    const tenant = await tenantAt([propertyA], email)
    const result = await emailFrom({ from: email })
    expect(result.outcome).toBe('ticket_opened')
    if (result.outcome !== 'ticket_opened') return

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: result.ticketId } })
    ticketIds.push(ticket.id)
    expect(ticket).toMatchObject({
      source: 'EMAIL',
      propertyId: propertyA,
      tenantId: tenant.id,
      // R-019's structured intake earns a category by ASKING; an email has
      // answered nothing, and a keyword guess would put a wrong label on a
      // path with no clarifying prompts to correct it.
      category: 'UNCATEGORIZED',
    })
    expect(ticket.description).toContain('The boiler is making a noise.')
  })

  it('does NOT open one for a reply, which is the difference from SMS', async () => {
    // Every "Thursday works" becoming a maintenance ticket would drown the
    // queue R-023's triage depends on being real.
    const email = `reply-${randomUUID().slice(0, 8)}@example.test`
    await tenantAt([propertyA], email)
    const result = await emailFrom({ from: email, body: 'Thursday works.', hasReplyKey: true })
    expect(result.outcome).toBe('threaded')
    expect(await prisma.ticket.count({ where: { description: { contains: 'Thursday works' } } }))
      .toBe(0)
  })

  it('does not open one for somebody asking to be unsubscribed', async () => {
    // A maintenance ticket titled "please unsubscribe me" is the visible half
    // of getting this wrong.
    const email = `nokticket-${randomUUID().slice(0, 8)}@example.test`
    const tenant = await tenantAt([propertyA], email)
    const result = await emailFrom({ from: email, body: 'Please unsubscribe me.' })
    expect(result.outcome).toBe('threaded')
    expect(await prisma.ticket.count({ where: { tenantId: tenant.id } })).toBe(0)
  })

  it('hangs the photograph off the ticket, so whoever is dispatched can see it', async () => {
    // Stored against the message by R-097d, which is where it belongs — and
    // without this the person sent to fix the leak never sees the picture.
    const email = `photo-t-${randomUUID().slice(0, 8)}@example.test`
    await tenantAt([propertyA], email)
    const result = await emailFrom({
      from: email,
      attachments: [
        { fileName: 'leak.jpg', contentType: 'image/jpeg', content: Buffer.alloc(2048, 7) },
      ],
    })
    expect(result.outcome).toBe('ticket_opened')
    if (result.outcome !== 'ticket_opened') return
    ticketIds.push(result.ticketId)
    const documents = await prisma.document.findMany({ where: { ticketId: result.ticketId } })
    expect(documents).toHaveLength(1)
    documentIds.push(documents[0]!.id)
  })

  it('never opens a ticket for a message nobody could route', async () => {
    // A ticket has to belong to a property and a tenant, and inventing
    // either is exactly what decideRoute refuses to do.
    const before = await prisma.ticket.count()
    const result = await emailFrom({ from: `nobody-${randomUUID().slice(0, 8)}@example.test` })
    expect(result.outcome).toBe('unrouted')
    expect(await prisma.ticket.count()).toBe(before)
  })
})
