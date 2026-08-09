import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postVendorPortalMessage, sendThreadMessage } from '@/lib/comms/messages.ts'
import { resolveThread } from '@/lib/comms/threads.ts'
import {
  unattachedTenantMessages,
  vendorWorkOrderThread,
  workOrderTimeline,
} from './timeline.ts'

// The merged timeline, against a real database (COMM-06, R-032).
//
// The assertion that matters most: a vendor with TWO concurrent jobs at the
// same property gets two separate conversations, and a message sent in one
// never appears on the other's timeline. That is the entire reason the
// vendor thread is scoped per work order rather than per property.

let entityId: string
let propertyId: string
let unitId: string
let tenantId: string
let vendorId: string
let staffId: string
const ticketIds: string[] = []
const workOrderIds: string[] = []

beforeAll(async () => {
  const stamp = `timeline-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${stamp}-house`,
      addressLine1: '21 Timeline Way',
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
    data: { firstName: 'Rae', lastName: `Timeline-${randomUUID().slice(0, 6)}` },
  })
  tenantId = tenant.id
  const vendor = await prisma.vendor.create({
    data: { name: `Vendor-${randomUUID().slice(0, 6)}`, trades: ['plumbing'] },
  })
  vendorId = vendor.id
  const staff = await prisma.staffUser.create({
    data: { email: `timeline-${randomUUID()}@example.test`, name: 'Alex' },
  })
  staffId = staff.id
})

afterAll(async () => {
  // Message is append-only (Message_append_only) and its ticketId/
  // workOrderId FKs are RESTRICT, so a Ticket or WorkOrder this suite
  // tagged a message onto cannot be deleted at all - the same reality
  // production lives with, since neither is ever deleted there either.
  // Everything downstream of them stays too, and only the roots without an
  // append-only chain pointing at them are cleaned up - deactivated, not
  // deleted, the same pattern every other suite that touches an audited row
  // uses.
  await prisma.workOrderNote.deleteMany({ where: { workOrderId: { in: workOrderIds } } })
  await prisma.tenant.updateMany({ where: { id: tenantId }, data: { active: false } })
  await prisma.vendor.updateMany({ where: { id: vendorId }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: staffId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedJob(description = 'The kitchen tap is leaking.') {
  const ticket = await prisma.ticket.create({
    data: {
      propertyId,
      unitId,
      tenantId,
      source: 'PORTAL',
      category: 'PLUMBING',
      description,
      priority: 'ROUTINE',
      status: 'CONVERTED',
      createdAt: new Date('2026-08-01T14:00:00Z'),
    },
  })
  ticketIds.push(ticket.id)
  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId,
      unitId,
      ticketId: ticket.id,
      vendorId,
      scope: 'Replace the cartridge',
      status: 'ASSIGNED',
    },
  })
  workOrderIds.push(workOrder.id)
  return { ticket, workOrder }
}

describe('vendorWorkOrderThread', () => {
  it('gives two concurrent jobs for the same vendor SEPARATE threads', async () => {
    const jobA = await seedJob()
    const jobB = await seedJob()

    const threadA = await vendorWorkOrderThread({
      id: jobA.workOrder.id,
      propertyId,
      vendorId,
    })
    const threadB = await vendorWorkOrderThread({
      id: jobB.workOrder.id,
      propertyId,
      vendorId,
    })

    expect(threadA.id).not.toBe(threadB.id)
    expect(threadA.workOrderId).toBe(jobA.workOrder.id)
    expect(threadB.workOrderId).toBe(jobB.workOrder.id)
  })

  it('gets-or-creates idempotently', async () => {
    const { workOrder } = await seedJob()
    const first = await vendorWorkOrderThread({ id: workOrder.id, propertyId, vendorId })
    const second = await vendorWorkOrderThread({ id: workOrder.id, propertyId, vendorId })
    expect(first.id).toBe(second.id)
  })
})

describe('workOrderTimeline', () => {
  it('merges the ticket, tenant, vendor and staff-note entries in chronological order', async () => {
    const { ticket, workOrder } = await seedJob('The kitchen tap is leaking badly.')

    const tenantThread = await resolveThread({ scope: 'TENANT', propertyId, tenantId })
    await sendThreadMessage({
      threadId: tenantThread.id,
      channel: 'PORTAL',
      body: 'Any update on when someone is coming?',
      staffUserId: staffId,
      toAddress: null,
      sentAt: new Date('2026-08-02T14:00:00Z'),
      ticketId: ticket.id,
      workOrderId: workOrder.id,
    })

    const vendorThread = await vendorWorkOrderThread({
      id: workOrder.id,
      propertyId,
      vendorId,
    })
    await postVendorPortalMessage({
      threadId: vendorThread.id,
      vendorId,
      workOrderId: workOrder.id,
      body: 'On my way, ETA 20 minutes.',
      sentAt: new Date('2026-08-03T14:00:00Z'),
    })

    await prisma.workOrderNote.create({
      data: {
        workOrderId: workOrder.id,
        staffUserId: staffId,
        body: 'Vendor confirmed the part is in stock.',
        createdAt: new Date('2026-08-02T20:00:00Z'),
      },
    })

    const entries = await workOrderTimeline(workOrder.id)

    expect(entries.map((e) => e.kind)).toEqual([
      'ticket_submitted',
      'staff_message',
      'staff_note',
      'vendor_message',
    ])
    expect(entries[0]).toMatchObject({
      body: 'The kitchen tap is leaking badly.',
    })
    expect(entries[3]).toMatchObject({
      author: expect.stringContaining('Vendor'),
      body: 'On my way, ETA 20 minutes.',
    })
  })

  it('leaves an untagged tenant message OFF the timeline', async () => {
    // The gap this item deliberately leaves open (see
    // unattachedTenantMessages's own comment): an ordinary inbound text has
    // no way to know which job it is about, so it does not appear here
    // until a human tags it.
    const { workOrder } = await seedJob()
    const thread = await resolveThread({ scope: 'TENANT', propertyId, tenantId })
    await prisma.message.create({
      data: {
        threadId: thread.id,
        channel: 'SMS',
        direction: 'INBOUND',
        body: 'Completely unrelated text about something else.',
        sentAt: new Date(),
        tenantId,
      },
    })

    const entries = await workOrderTimeline(workOrder.id)
    expect(entries.some((e) => e.body.includes('Completely unrelated'))).toBe(false)
  })

  it('does not leak a message from a DIFFERENT job onto this one', async () => {
    const jobA = await seedJob()
    const jobB = await seedJob()
    const threadA = await vendorWorkOrderThread({
      id: jobA.workOrder.id,
      propertyId,
      vendorId,
    })
    await postVendorPortalMessage({
      threadId: threadA.id,
      vendorId,
      workOrderId: jobA.workOrder.id,
      body: 'This is about job A only.',
    })

    const entriesB = await workOrderTimeline(jobB.workOrder.id)
    expect(entriesB.some((e) => e.body.includes('job A only'))).toBe(false)
  })
})

describe('a message attached after the fact (WorkOrderMessageLink)', () => {
  it('appears on the timeline once linked, without touching the message row', async () => {
    const { workOrder } = await seedJob()
    const thread = await resolveThread({ scope: 'TENANT', propertyId, tenantId })
    const message = await prisma.message.create({
      data: {
        threadId: thread.id,
        channel: 'SMS',
        direction: 'INBOUND',
        body: 'Actually still leaking, worse now.',
        sentAt: new Date(),
        tenantId,
      },
    })

    await prisma.workOrderMessageLink.create({
      data: { workOrderId: workOrder.id, messageId: message.id, linkedByStaffId: staffId },
    })

    const entries = await workOrderTimeline(workOrder.id)
    expect(entries.some((e) => e.body === 'Actually still leaking, worse now.')).toBe(
      true,
    )

    // The message row itself is untouched - ticketId/workOrderId are still
    // null, exactly as Message's append-only trigger requires. The link
    // table is the only record of the attachment.
    const unchanged = await prisma.message.findUniqueOrThrow({ where: { id: message.id } })
    expect(unchanged.ticketId).toBeNull()
    expect(unchanged.workOrderId).toBeNull()
  })

  it('removes it from the candidate list once linked', async () => {
    const { workOrder } = await seedJob()
    const thread = await resolveThread({ scope: 'TENANT', propertyId, tenantId })
    const message = await prisma.message.create({
      data: {
        threadId: thread.id,
        channel: 'SMS',
        direction: 'INBOUND',
        body: 'Please send someone today.',
        sentAt: new Date(),
        tenantId,
      },
    })

    expect(
      (await unattachedTenantMessages(workOrder.id)).map((c) => c.id),
    ).toContain(message.id)

    await prisma.workOrderMessageLink.create({
      data: { workOrderId: workOrder.id, messageId: message.id, linkedByStaffId: staffId },
    })

    expect(
      (await unattachedTenantMessages(workOrder.id)).map((c) => c.id),
    ).not.toContain(message.id)
  })
})

describe('unattachedTenantMessages', () => {
  it('surfaces an untagged inbound tenant message', async () => {
    const { workOrder } = await seedJob()
    const thread = await resolveThread({ scope: 'TENANT', propertyId, tenantId })
    const message = await prisma.message.create({
      data: {
        threadId: thread.id,
        channel: 'SMS',
        direction: 'INBOUND',
        body: 'Still dripping, can someone come by?',
        sentAt: new Date(),
        tenantId,
      },
    })

    const candidates = await unattachedTenantMessages(workOrder.id)
    expect(candidates.map((c) => c.id)).toContain(message.id)
  })

  it('EXCLUDES a message already tagged to any job', async () => {
    const { ticket, workOrder } = await seedJob()
    const thread = await resolveThread({ scope: 'TENANT', propertyId, tenantId })
    await prisma.message.create({
      data: {
        threadId: thread.id,
        channel: 'SMS',
        direction: 'INBOUND',
        body: 'Already attached to this very job.',
        sentAt: new Date(),
        tenantId,
        ticketId: ticket.id,
        workOrderId: workOrder.id,
      },
    })

    const candidates = await unattachedTenantMessages(workOrder.id)
    expect(candidates.some((c) => c.body.includes('Already attached'))).toBe(false)
  })

  it('EXCLUDES an outbound staff reply - only the tenant’s own words are candidates', async () => {
    const { workOrder } = await seedJob()
    const thread = await resolveThread({ scope: 'TENANT', propertyId, tenantId })
    await sendThreadMessage({
      threadId: thread.id,
      channel: 'PORTAL',
      body: 'We are on our way.',
      staffUserId: staffId,
      toAddress: null,
    })

    const candidates = await unattachedTenantMessages(workOrder.id)
    expect(candidates.some((c) => c.body === 'We are on our way.')).toBe(false)
  })
})
