import { prisma } from '@rental/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getTask, myDayTasks, rollupByProperty } from './queries.ts'

// Reads for the Task queue (D-9, R-011), against a real database.

let entityId: string
let propA: string
let propB: string
let staffA: string
let staffB: string
const taskIds: string[] = []
const propertyIds: string[] = []
const staffIds: string[] = []

function scopeOf(ids: string[]) {
  return {
    selection: { kind: 'all' as const },
    availableEntities: [],
    availableProperties: [],
    propertyIds: ids,
    switchable: ids.length > 1,
  }
}

beforeAll(async () => {
  const stamp = `taskq-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id

  const makeProperty = async (name: string) => {
    const property = await prisma.property.create({
      data: {
        legalEntityId: entityId,
        name: `${stamp}-${name}`,
        addressLine1: '1 Test St',
        city: 'Houston',
        state: 'TX',
        postalCode: '77002',
        timezone: 'America/Chicago',
        propertyType: 'SINGLE_FAMILY',
      },
    })
    propertyIds.push(property.id)
    return property
  }
  const a = await makeProperty('A')
  const b = await makeProperty('B')
  propA = a.id
  propB = b.id

  const makeStaff = async (name: string) => {
    const staff = await prisma.staffUser.create({
      data: { email: `${stamp}-${name}@example.test`, name },
    })
    staffIds.push(staff.id)
    return staff.id
  }
  staffA = await makeStaff('staffA')
  staffB = await makeStaff('staffB')

  const makeTask = async (data: {
    propertyId: string
    businessDate: string
    priority?: string
    status?: string
    assigneeStaffId?: string | null
    subjectId: string
    title: string
  }) => {
    const task = await prisma.task.create({
      data: {
        propertyId: data.propertyId,
        type: 'test.query',
        subjectType: 'Lease',
        subjectId: data.subjectId,
        businessDate: new Date(`${data.businessDate}T00:00:00.000Z`),
        priority: (data.priority ?? 'ROUTINE') as never,
        status: (data.status ?? 'OPEN') as never,
        assigneeStaffId: data.assigneeStaffId,
        title: data.title,
      },
    })
    taskIds.push(task.id)
    return task
  }

  // Far in the past so "today or overdue" always includes it, whenever the
  // suite runs.
  await makeTask({
    propertyId: propA,
    businessDate: '2020-01-01',
    subjectId: 'unassigned-overdue',
    title: 'Unassigned, overdue',
  })
  await makeTask({
    propertyId: propA,
    businessDate: '2020-01-01',
    assigneeStaffId: staffA,
    subjectId: 'mine-overdue',
    title: 'Assigned to me, overdue',
    priority: 'EMERGENCY',
  })
  await makeTask({
    propertyId: propA,
    businessDate: '2020-01-01',
    assigneeStaffId: staffB,
    subjectId: 'theirs-overdue',
    title: "Assigned to someone else",
  })
  await makeTask({
    propertyId: propA,
    businessDate: '2099-01-01',
    subjectId: 'future',
    title: 'Not due yet',
  })
  await makeTask({
    propertyId: propA,
    businessDate: '2020-01-01',
    status: 'DONE',
    subjectId: 'already-done',
    title: 'Already done',
  })
  await makeTask({
    propertyId: propB,
    businessDate: '2020-01-01',
    subjectId: 'other-property',
    title: 'On property B',
  })
})

afterAll(async () => {
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } })
  await prisma.staffUser.deleteMany({ where: { id: { in: staffIds } } })
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } })
  await prisma.legalEntity.delete({ where: { id: entityId } })
  await prisma.$disconnect()
})

describe('myDayTasks', () => {
  it('includes unassigned and mine, excludes someone else\'s, future and done', async () => {
    const tasks = await myDayTasks(scopeOf([propA, propB]), staffA, new Date())
    const titles = tasks.map((t) => t.title)
    expect(titles).toContain('Unassigned, overdue')
    expect(titles).toContain('Assigned to me, overdue')
    expect(titles).not.toContain('Assigned to someone else')
    expect(titles).not.toContain('Not due yet')
    expect(titles).not.toContain('Already done')
  })

  it('sorts emergency before routine', async () => {
    const tasks = await myDayTasks(scopeOf([propA]), staffA, new Date())
    const emergencyIndex = tasks.findIndex((t) => t.priority === 'EMERGENCY')
    const routineIndex = tasks.findIndex((t) => t.title === 'Unassigned, overdue')
    expect(emergencyIndex).toBeLessThan(routineIndex)
  })

  it('returns nothing outside scope', async () => {
    expect(await myDayTasks(scopeOf([propB]), staffA, new Date())).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ title: 'Unassigned, overdue' })]),
    )
  })

  it('returns an empty list for an empty scope', async () => {
    expect(await myDayTasks(scopeOf([]), staffA, new Date())).toEqual([])
  })
})

describe('rollupByProperty', () => {
  it('counts open and overdue tasks per property', async () => {
    const rollup = await rollupByProperty(scopeOf([propA, propB]), new Date())
    const a = rollup.find((r) => r.propertyId === propA)!
    const b = rollup.find((r) => r.propertyId === propB)!

    // Property A: 4 open (unassigned-overdue, mine-overdue, theirs-overdue,
    // future) - DONE is excluded. 3 of those are overdue (not the future one).
    expect(a.open).toBe(4)
    expect(a.overdue).toBe(3)
    expect(a.emergency).toBe(1)
    expect(b.open).toBe(1)
    expect(b.overdue).toBe(1)
  })
})

describe('getTask', () => {
  it('returns a task whose property is in scope', async () => {
    const tasks = await myDayTasks(scopeOf([propA]), staffA, new Date())
    const task = await getTask(tasks[0]!.id, scopeOf([propA]))
    expect(task?.id).toBe(tasks[0]!.id)
    expect(task?.property.id).toBe(propA)
  })

  it('returns null when the property is outside scope', async () => {
    const tasks = await myDayTasks(scopeOf([propA]), staffA, new Date())
    expect(await getTask(tasks[0]!.id, scopeOf([propB]))).toBeNull()
  })
})
