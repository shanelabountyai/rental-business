import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sweepUnansweredTenantMessages } from './unanswered-sweep.ts'

// COMM-07: "unanswered tenant messages past X days surface on the
// dashboard." The Task this raises IS what the dashboard tile counts
// (dashboard/queries.ts's unansweredMessagesSummary) - this covers the
// sweep that decides which threads qualify.

const NOW = new Date('2026-08-17T15:00:00.000Z')
const DAYS = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)

let propertyId: string
let entityId: string
const threadIds: string[] = []
const taskIds: string[] = []

beforeAll(async () => {
  const stamp = `unanswered-${randomUUID().slice(0, 8)}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: stamp,
      addressLine1: '9 Silent Court',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
})

afterAll(async () => {
  // Message is append-only (trigger-enforced); Thread is left standing too,
  // since Message still references it. Deactivating the property is what
  // keeps a re-run from tripping over this run's fixtures.
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
})

async function seedTenant(name: string) {
  return prisma.tenant.create({ data: { firstName: name, lastName: `Test-${randomUUID().slice(0, 6)}` } })
}

async function seedThread(tenantId: string, key: string) {
  const thread = await prisma.thread.create({
    data: { key, propertyId, tenantId },
  })
  threadIds.push(thread.id)
  return thread
}

async function seedMessage(threadId: string, direction: 'INBOUND' | 'OUTBOUND', sentAt: Date) {
  await prisma.message.create({
    data: { threadId, channel: 'SMS', direction, body: 'hi', sentAt },
  })
  await prisma.thread.update({ where: { id: threadId }, data: { lastMessageAt: sentAt } })
}

describe('sweepUnansweredTenantMessages', () => {
  it('flags a thread whose newest message is INBOUND and past the threshold', async () => {
    const tenant = await seedTenant('Overdue')
    const thread = await seedThread(tenant.id, `unanswered-flagged-${randomUUID()}`)
    await seedMessage(thread.id, 'INBOUND', DAYS(3))

    const result = await sweepUnansweredTenantMessages(NOW, { threadIds: [thread.id] })
    expect(result.flagged).toBe(1)

    const task = await prisma.task.findFirst({ where: { subjectId: thread.id, type: 'tenant_unanswered' } })
    expect(task).not.toBeNull()
    if (task) taskIds.push(task.id)
  })

  it('does NOT flag a thread staff already answered', async () => {
    const tenant = await seedTenant('Answered')
    const thread = await seedThread(tenant.id, `unanswered-answered-${randomUUID()}`)
    await seedMessage(thread.id, 'INBOUND', DAYS(5))
    await seedMessage(thread.id, 'OUTBOUND', DAYS(4))

    await sweepUnansweredTenantMessages(NOW, { threadIds: [thread.id] })

    const task = await prisma.task.findFirst({ where: { subjectId: thread.id, type: 'tenant_unanswered' } })
    expect(task).toBeNull()
  })

  it('does NOT flag a thread still inside the threshold', async () => {
    const tenant = await seedTenant('Recent')
    const thread = await seedThread(tenant.id, `unanswered-recent-${randomUUID()}`)
    await seedMessage(thread.id, 'INBOUND', DAYS(0))

    await sweepUnansweredTenantMessages(NOW, { threadIds: [thread.id] })

    const task = await prisma.task.findFirst({ where: { subjectId: thread.id, type: 'tenant_unanswered' } })
    expect(task).toBeNull()
  })

  it('is idempotent per day - a second sweep the same day does not raise a duplicate', async () => {
    const tenant = await seedTenant('Twice')
    const thread = await seedThread(tenant.id, `unanswered-twice-${randomUUID()}`)
    await seedMessage(thread.id, 'INBOUND', DAYS(3))

    await sweepUnansweredTenantMessages(NOW, { threadIds: [thread.id] })
    await sweepUnansweredTenantMessages(new Date(NOW.getTime() + 60 * 60 * 1000), {
      threadIds: [thread.id],
    })

    const tasks = await prisma.task.findMany({ where: { subjectId: thread.id, type: 'tenant_unanswered' } })
    expect(tasks.length).toBe(1)
    taskIds.push(...tasks.map((t) => t.id))
  })
})
