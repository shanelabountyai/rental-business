import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan } from './fixtures.ts'

// The one Task queue (D-9, R-011). Built before its first real consumer, so
// every task here is either seeded directly (standing in for a future
// producer) or added through the one staff-initiated path this item ships:
// an ad-hoc "add task" form.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const taskIds: string[] = []

async function createStaff(
  roleKey: string,
  scope?: { propertyId?: string; legalEntityId?: string },
) {
  const email = `tasks-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Tasks Test',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  await prisma.staffAssignment.create({
    data: {
      staffUserId: staff.id,
      roleId: role.id,
      propertyId: scope?.propertyId,
      legalEntityId: scope?.legalEntityId,
    },
  })
  return { ...staff, password: PASSWORD }
}

async function seedProperty(name = 'Seed House') {
  const entity = await prisma.legalEntity.create({
    data: { name: `Seed LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${name}-${randomUUID().slice(0, 8)}`,
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  return { entity, property }
}

async function seedTask(
  propertyId: string,
  overrides: Partial<{ title: string; priority: string; assigneeStaffId: string | null }> = {},
) {
  const task = await prisma.task.create({
    data: {
      propertyId,
      type: 'test.seed',
      subjectType: 'Lease',
      subjectId: randomUUID(),
      businessDate: new Date('2020-01-01T00:00:00.000Z'),
      priority: (overrides.priority ?? 'ROUTINE') as never,
      title: overrides.title ?? 'Seeded task',
      assigneeStaffId: overrides.assigneeStaffId,
    },
  })
  taskIds.push(task.id)
  return task
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  const auditedTasks = new Set(
    (
      await prisma.auditLog.findMany({
        where: { entityType: 'Task', entityId: { in: taskIds } },
        select: { entityId: true },
      })
    ).map((row) => row.entityId),
  )
  await prisma.task.deleteMany({
    where: { id: { in: taskIds.filter((id) => !auditedTasks.has(id)) } },
  })

  const auditedProperties = new Set(
    (
      await prisma.auditLog.findMany({
        where: { propertyId: { in: propertyIds } },
        select: { propertyId: true },
      })
    ).map((row) => row.propertyId!),
  )
  await prisma.property.deleteMany({
    where: { id: { in: propertyIds.filter((id) => !auditedProperties.has(id)) } },
  })
  await prisma.property.updateMany({
    where: { id: { in: [...auditedProperties] } },
    data: { active: false },
  })
  const stillReferenced = new Set(
    (
      await prisma.property.findMany({
        where: { legalEntityId: { in: entityIds } },
        select: { legalEntityId: true },
      })
    ).map((row) => row.legalEntityId),
  )
  await prisma.legalEntity.deleteMany({
    where: { id: { in: entityIds.filter((id) => !stillReferenced.has(id)) } },
  })

  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  const auditedStaff = new Set(
    (
      await prisma.auditLog.findMany({
        where: { actorStaffId: { in: staffIds } },
        select: { actorStaffId: true },
      })
    ).map((row) => row.actorStaffId!),
  )
  await prisma.staffCredential.deleteMany({
    where: { staffUserId: { in: staffIds.filter((id) => !auditedStaff.has(id)) } },
  })
  await prisma.staffUser.deleteMany({
    where: { id: { in: staffIds.filter((id) => !auditedStaff.has(id)) } },
  })
  await prisma.staffUser.updateMany({
    where: { id: { in: [...auditedStaff] } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.describe('the my-day list and roll-up', () => {
  test('shows an overdue task and the portfolio roll-up', async ({ page }) => {
    const { property } = await seedProperty()
    await seedTask(property.id, { title: 'Unassigned overdue task' })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/tasks')
    await expect(page.getByText('Unassigned overdue task')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Portfolio roll-up' })).toBeVisible()
    await expect(page.getByRole('cell', { name: property.name })).toBeVisible()
  })

  test('does not show a task assigned to someone else', async ({ page }) => {
    const { property } = await seedProperty()
    const other = await createStaff('manager', { propertyId: property.id })
    await seedTask(property.id, {
      title: 'Someone elses task',
      assigneeStaffId: other.id,
    })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/tasks')
    await expect(page.getByText('Someone elses task')).toHaveCount(0)
  })
})

test.describe('adding a task', () => {
  test('adds an ad-hoc task end to end', async ({ page }) => {
    const { property } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/tasks/new')
    await page.getByLabel('Property *').selectOption(property.id)
    await page.getByLabel('Title').fill('Check smoke detector batteries')
    await page.getByLabel('Priority').selectOption('URGENT')
    await page.getByRole('button', { name: 'Add task' }).click()

    await page.waitForURL(/\/tasks\/.+/)
    await expect(page.getByRole('heading', { name: 'Check smoke detector batteries' })).toBeVisible()

    const created = await prisma.task.findFirst({
      where: { propertyId: property.id, title: 'Check smoke detector batteries' },
    })
    taskIds.push(created!.id)
    expect(created?.subjectType).toBe('AdHoc')
    expect(created?.priority).toBe('URGENT')
  })
})

test.describe('working a task', () => {
  test('claims, then completes with a note', async ({ page }) => {
    const { property } = await seedProperty()
    const task = await seedTask(property.id, { title: 'Follow up with tenant' })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/tasks/${task.id}`)
    await expect(page.getByText('Unclaimed - anyone may pick this up')).toBeVisible()
    await page.getByRole('button', { name: 'Claim this task' }).click()
    await expect(page.getByText(staff.name)).toBeVisible()

    await page.getByLabel('Note (optional)').fill('Left a voicemail')
    await page.getByRole('button', { name: 'Mark complete' }).click()
    await page.waitForURL('**/tasks')

    const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(updated.status).toBe('DONE')
    expect(updated.completedByStaffId).toBe(staff.id)
    expect((updated.proof as { note?: string } | null)?.note).toBe('Left a voicemail')
  })

  test('refuses to let a second person steal an already-claimed task', async ({
    page,
  }) => {
    const { property } = await seedProperty()
    const claimer = await createStaff('owner')
    const task = await seedTask(property.id, {
      title: 'Already claimed',
      assigneeStaffId: claimer.id,
    })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/tasks/${task.id}`)
    // Already assigned to someone else - no claim button offered at all.
    await expect(page.getByRole('button', { name: 'Claim this task' })).toHaveCount(0)
  })

  test('cancels a task', async ({ page }) => {
    const { property } = await seedProperty()
    const task = await seedTask(property.id, { title: 'No longer needed' })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/tasks/${task.id}`)
    await page.getByRole('button', { name: 'Cancel task' }).click()
    await page.waitForURL('**/tasks')

    const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(updated.status).toBe('CANCELED')
  })
})

test.describe('scoping (ROLE-01)', () => {
  test('a property-scoped manager sees only their own property in the roll-up', async ({
    page,
  }) => {
    const { property: mine } = await seedProperty('Mine')
    const { property: theirs } = await seedProperty('Theirs')
    await seedTask(mine.id, { title: 'On my property' })
    await seedTask(theirs.id, { title: 'On their property' })
    const staff = await createStaff('manager', { propertyId: mine.id })
    await signIn(page, staff.email)

    await page.goto('/tasks')
    await expect(page.getByText('On my property')).toBeVisible()
    await expect(page.getByText('On their property')).toHaveCount(0)
  })

  // Regression coverage for the propertyResource() bug R-008 shipped and
  // R-009/R-010 both found instances of: an entity-scoped manager must be
  // able to work a task on a property that belongs to their own entity.
  test('an entity-scoped manager can work a task on a property in their entity', async ({
    page,
  }) => {
    const { entity, property } = await seedProperty()
    const task = await seedTask(property.id, { title: 'Entity scoped task' })
    const staff = await createStaff('manager', { legalEntityId: entity.id })
    await signIn(page, staff.email)

    await page.goto(`/tasks/${task.id}`)
    await expect(page).not.toHaveURL(/\/no-access/)
    await expect(page.getByRole('button', { name: 'Claim this task' })).toBeVisible()
  })

  test('a maintenance tech without task.write for this property cannot act on it', async ({
    page,
  }) => {
    const { property: mine } = await seedProperty('Mine')
    const { property: theirs } = await seedProperty('Theirs')
    const task = await seedTask(theirs.id, { title: 'Not my property' })
    const staff = await createStaff('maintenance_tech', { propertyId: mine.id })
    await signIn(page, staff.email)

    const response = await page.goto(`/tasks/${task.id}`)
    expect(response?.status()).toBe(404)
  })
})

test.describe('accessibility', () => {
  test('the list, add-task and detail pages have no detectable violations', async ({
    page,
  }) => {
    const { property } = await seedProperty()
    const task = await seedTask(property.id)
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/tasks')
    let results = await axeScan(page)
    expect(results.violations).toEqual([])

    await page.goto('/tasks/new')
    results = await axeScan(page)
    expect(results.violations).toEqual([])

    await page.goto(`/tasks/${task.id}`)
    results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})
