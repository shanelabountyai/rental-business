import { createHmac, randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POST } from './route.ts'

// Resend's delivery webhook (R-054's bounce/failure path).
//
// Driven through the real route function with real Svix signatures, the way
// the Twilio status callback is tested (status-route.test.ts) - the
// signature check is the entire authentication story for a public endpoint.
//
// Nothing posts here in this build - provider.ts still wires the logging
// adapter (D-15). Tested now for the same reason: the alternative is
// discovering the event mapping is wrong on the day real mail starts moving.

const SECRET_RAW = Buffer.from('test-resend-webhook-secret-r054', 'utf8')
const SECRET = `whsec_${SECRET_RAW.toString('base64')}`

let propertyId: string
let entityId: string
let tenantId: string
const notificationIds: string[] = []
const messageIds: string[] = []
const threadIds: string[] = []
const taskIds: string[] = []

let previousSecret: string | undefined

beforeAll(async () => {
  previousSecret = process.env.RESEND_WEBHOOK_SECRET
  process.env.RESEND_WEBHOOK_SECRET = SECRET

  const stamp = `resend-webhook-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: stamp,
      addressLine1: '11 Bounce Lane',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Bounced', lastName: `Inbox-${randomUUID().slice(0, 6)}`, email: 'dead@example.test' },
  })
  tenantId = tenant.id
})

afterAll(async () => {
  if (previousSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET
  else process.env.RESEND_WEBHOOK_SECRET = previousSecret

  // Message and Notification are both append-only (trigger-enforced), and
  // Thread is left standing too since Message still references it - same
  // reasoning status-route.test.ts already applies to Notification.
  // Deactivating the property is what keeps a re-run from tripping over
  // this run's fixtures.
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function seedNotificationDelivery(status: 'SENT' | 'DELIVERED', externalId: string) {
  const notification = await prisma.notification.create({
    data: {
      category: 'rent_reminder',
      channel: 'EMAIL',
      recipientType: 'TENANT',
      recipientId: tenantId,
      toAddress: 'dead@example.test',
      templateKey: 'payment.due_soon',
      subject: 'Rent is due soon',
      body: 'Rent is due in three days.',
      idempotencyKey: `test:resend:${randomUUID()}`,
      propertyId,
      delivery: { create: { status, externalId } },
    },
  })
  notificationIds.push(notification.id)
  return notification
}

async function seedMessageDelivery(status: 'SENT' | 'DELIVERED', externalId: string) {
  const thread = await prisma.thread.create({
    data: { key: `resend-webhook-${randomUUID()}`, propertyId, tenantId },
  })
  threadIds.push(thread.id)
  const message = await prisma.message.create({
    data: {
      threadId: thread.id,
      channel: 'EMAIL',
      direction: 'OUTBOUND',
      body: 'A staff reply.',
      sentAt: new Date(),
      tenantId,
      delivery: { create: { status, externalId } },
    },
  })
  messageIds.push(message.id)
  return message
}

function post(payload: unknown, opts: { badSignature?: boolean; noSignature?: boolean } = {}) {
  const rawBody = JSON.stringify(payload)
  const svixId = `msg_${randomUUID()}`
  const svixTimestamp = String(Math.floor(Date.now() / 1000))
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`
  const signature = createHmac('sha256', SECRET_RAW).update(signedContent).digest('base64')

  const headers: Record<string, string> = {}
  if (!opts.noSignature) {
    headers['svix-id'] = svixId
    headers['svix-timestamp'] = svixTimestamp
    headers['svix-signature'] = opts.badSignature ? 'v1,not-a-real-signature' : `v1,${signature}`
  }

  return POST(
    new Request('https://rental.example.test/api/webhooks/resend', {
      method: 'POST',
      headers,
      body: rawBody,
    }),
  )
}

describe('the Resend delivery webhook', () => {
  it('REFUSES an unsigned or forged callback', async () => {
    const response = await post(
      { type: 'email.bounced', data: { email_id: 're_1' } },
      { badSignature: true },
    )
    expect(response.status).toBe(403)
  })

  it('records DELIVERED on a NotificationDelivery row', async () => {
    const id = `re_${randomUUID()}`
    const notification = await seedNotificationDelivery('SENT', id)

    const response = await post({ type: 'email.delivered', data: { email_id: id } })
    expect(response.status).toBe(204)

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId: notification.id },
    })
    expect(delivery.status).toBe('DELIVERED')
    expect(delivery.deliveredAt).not.toBeNull()
  })

  it('records BOUNCED and raises a Task flagging the tenant', async () => {
    const id = `re_${randomUUID()}`
    const notification = await seedNotificationDelivery('SENT', id)

    const response = await post({ type: 'email.bounced', data: { email_id: id } })
    expect(response.status).toBe(204)

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId: notification.id },
    })
    expect(delivery.status).toBe('BOUNCED')
    expect(delivery.failedAt).not.toBeNull()

    const task = await prisma.task.findFirst({
      where: { type: 'tenant_email_bounced', subjectId: tenantId },
    })
    expect(task).not.toBeNull()
    expect(task?.propertyId).toBe(propertyId)
    if (task) taskIds.push(task.id)
  })

  it('also finds and records a MessageDelivery row (a staff reply, not an automated notification)', async () => {
    const id = `re_${randomUUID()}`
    const message = await seedMessageDelivery('SENT', id)

    const response = await post({ type: 'email.bounced', data: { email_id: id } })
    expect(response.status).toBe(204)

    const delivery = await prisma.messageDelivery.findUniqueOrThrow({
      where: { messageId: message.id },
    })
    expect(delivery.status).toBe('BOUNCED')

    const task = await prisma.task.findFirst({
      where: { type: 'tenant_email_bounced', subjectId: tenantId },
    })
    if (task) taskIds.push(task.id)
  })

  it('ignores an event this build does not act on', async () => {
    const id = `re_${randomUUID()}`
    await seedNotificationDelivery('SENT', id)

    const response = await post({ type: 'email.opened', data: { email_id: id } })
    expect(response.status).toBe(204)

    const delivery = await prisma.notificationDelivery.findFirst({
      where: { externalId: id },
    })
    expect(delivery?.status).toBe('SENT')
  })

  it('REFUSES to walk a record backwards when callbacks arrive out of order', async () => {
    const id = `re_${randomUUID()}`
    const notification = await seedNotificationDelivery('DELIVERED', id)

    // A stale "delivered" landing after a bounce would be a false record -
    // but here it's a stale duplicate arriving after DELIVERED, which
    // shouldApplyStatus also refuses as a no-op.
    await post({ type: 'email.delivered', data: { email_id: id } })

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId: notification.id },
    })
    expect(delivery.status).toBe('DELIVERED')
  })

  it('accepts a callback for a message it cannot match, without asking for a retry', async () => {
    const response = await post({ type: 'email.bounced', data: { email_id: `re_${randomUUID()}` } })
    expect(response.status).toBe(204)
  })
})
