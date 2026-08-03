import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTask } from './create.ts'

// The idempotent creation primitive every future task producer calls
// (D-9). What matters: two callers racing to create the same
// (type, subjectId, businessDate) must produce exactly one row.

let propertyId: string
let entityId: string
const taskIds: string[] = []

beforeAll(async () => {
  const stamp = `taskcreate-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '1 Test St',
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
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } })
  await prisma.property.delete({ where: { id: propertyId } })
  await prisma.legalEntity.delete({ where: { id: entityId } })
  await prisma.$disconnect()
})

describe('createTask', () => {
  it('creates a task with the given fields', async () => {
    const { task, created } = await createTask(prisma, {
      propertyId,
      type: 'test.create',
      subjectType: 'Lease',
      subjectId: 'lease_a',
      businessDate: '2026-08-03',
      priority: 'ROUTINE',
      title: 'Call the tenant back',
    })
    taskIds.push(task.id)
    expect(created).toBe(true)
    expect(task.title).toBe('Call the tenant back')
    expect(task.status).toBe('OPEN')
  })

  it('is idempotent on (type, subjectId, businessDate): the second call returns the first row', async () => {
    const first = await createTask(prisma, {
      propertyId,
      type: 'test.idempotent',
      subjectType: 'Lease',
      subjectId: 'lease_b',
      businessDate: '2026-08-03',
      priority: 'URGENT',
      title: 'First title wins',
    })
    taskIds.push(first.task.id)

    const second = await createTask(prisma, {
      propertyId,
      type: 'test.idempotent',
      subjectType: 'Lease',
      subjectId: 'lease_b',
      businessDate: '2026-08-03',
      priority: 'EMERGENCY',
      title: 'Second call, different title',
    })

    expect(second.created).toBe(false)
    expect(second.task.id).toBe(first.task.id)
    expect(second.task.title).toBe('First title wins')
    expect(second.task.priority).toBe('URGENT')
  })

  it('creates a distinct task for a different subject on the same day', async () => {
    const a = await createTask(prisma, {
      propertyId,
      type: 'test.distinct',
      subjectType: 'Lease',
      subjectId: 'lease_c',
      businessDate: '2026-08-03',
      priority: 'ROUTINE',
      title: 'Lease C',
    })
    const b = await createTask(prisma, {
      propertyId,
      type: 'test.distinct',
      subjectType: 'Lease',
      subjectId: 'lease_d',
      businessDate: '2026-08-03',
      priority: 'ROUTINE',
      title: 'Lease D',
    })
    taskIds.push(a.task.id, b.task.id)
    expect(a.task.id).not.toBe(b.task.id)
  })

  it('creates a distinct task for the same subject on a different day', async () => {
    const day1 = await createTask(prisma, {
      propertyId,
      type: 'test.sameSubjectDifferentDay',
      subjectType: 'Lease',
      subjectId: 'lease_e',
      businessDate: '2026-08-03',
      priority: 'ROUTINE',
      title: 'Day 1',
    })
    const day2 = await createTask(prisma, {
      propertyId,
      type: 'test.sameSubjectDifferentDay',
      subjectType: 'Lease',
      subjectId: 'lease_e',
      businessDate: '2026-08-04',
      priority: 'ROUTINE',
      title: 'Day 2',
    })
    taskIds.push(day1.task.id, day2.task.id)
    expect(day1.task.id).not.toBe(day2.task.id)
  })
})
