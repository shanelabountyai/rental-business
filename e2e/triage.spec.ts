import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { hashPassword } from '@rental/core/auth'
import { CATEGORY_LABELS } from '@rental/core/maintenance'
import { businessDate, businessDateToUtc } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// Triage queue as a Task view (MAINT-02, RISK-05, R-023): a new ticket
// becomes a Task in the ONE staff queue (D-9), and the ticket-specific
// triage actions - priority override, merge, the three terminal
// resolutions - live on that Task's own detail page.
//
// The Ticket -> Task creation itself (the ticket.created consumer,
// triage-consumer.ts) is proved separately, against the real registered
// consumer, in its own narrowly-scoped Vitest integration test - see that
// file's own header for why. This spec seeds the Task directly (the exact
// shape that consumer produces) so it can focus on what is actually R-023's
// own surface: the triage actions and the page that hosts them.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const ticketIds: string[] = []
const taskIds: string[] = []

async function createStaff(
  roleKey: string,
  scope?: { propertyId?: string; legalEntityId?: string },
) {
  const email = `triage-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Triage Test',
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

/// The exact row shape triage-consumer.ts produces from a ticket.created
/// event - seeded directly rather than emitting the event and dispatching
/// the real outbox, which is that consumer's own, separately-covered
/// concern (see this file's header).
async function seedTriageTask(
  ticket: {
    id: string
    propertyId: string
    category: string
    priority: string
    habitabilityFlag: boolean
  },
  property: { timezone: string },
  unit: { name: string },
) {
  const categoryLabel =
    CATEGORY_LABELS[ticket.category as keyof typeof CATEGORY_LABELS] ?? 'Uncategorized'
  const title = ticket.habitabilityFlag
    ? `Habitability: ${categoryLabel} — ${unit.name}`
    : `Triage: ${categoryLabel} — ${unit.name}`

  const task = await prisma.task.create({
    data: {
      propertyId: ticket.propertyId,
      type: 'ticket_triage',
      subjectType: 'Ticket',
      subjectId: ticket.id,
      businessDate: businessDateToUtc(businessDate(new Date(), property.timezone)),
      priority: ticket.priority as never,
      title,
    },
  })
  taskIds.push(task.id)
  return task
}

async function seedTicket(
  overrides: Partial<{
    category: string
    priority: string
    habitabilityFlag: boolean
    propertyName: string
  }> = {},
) {
  const entity = await prisma.legalEntity.create({
    data: { name: `Triage LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${overrides.propertyName ?? 'Triage House'}-${randomUUID().slice(0, 8)}`,
      addressLine1: '3 Queue Court',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Tia', lastName: `Triage-${randomUUID().slice(0, 6)}` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })

  const ticket = await prisma.ticket.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      leaseId: lease.id,
      tenantId: tenant.id,
      source: 'PORTAL',
      category: overrides.category ?? 'PLUMBING',
      description: 'The kitchen faucet will not stop dripping.',
      priority: (overrides.priority ?? 'URGENT') as never,
      habitabilityFlag: overrides.habitabilityFlag ?? false,
    },
  })
  ticketIds.push(ticket.id)

  const task = await seedTriageTask(ticket, property, unit)

  return { property, unit, tenant, ticket, task }
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.leaseTenant.deleteMany({ where: { tenantId: { in: tenantIds } } })
  await prisma.lease.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.unit.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })

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

test.describe('a ticket-triage Task', () => {
  test('carries the ticket into the one queue', async ({ page }) => {
    const { task } = await seedTicket({ category: 'PLUMBING', habitabilityFlag: true })

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto(`/tasks/${task.id}`)

    // exact: true throughout - the Task's own auto-generated title also
    // contains "Plumbing"/"Habitability" as a substring ("Habitability:
    // Plumbing — Unit A"), and a bare getByText would match both that
    // heading and the panel's own category/badge spans.
    await expect(page.getByText('Plumbing', { exact: true })).toBeVisible()
    await expect(page.getByText('kitchen faucet will not stop dripping')).toBeVisible()
    await expect(page.getByText('Habitability', { exact: true })).toBeVisible()
  })

  test('setting priority moves the ticket to TRIAGED and stamps first response', async ({
    page,
  }) => {
    const { ticket, task } = await seedTicket()

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto(`/tasks/${task.id}`)

    await page.getByLabel('Priority').selectOption('ROUTINE')
    await page.getByRole('button', { name: 'Set priority' }).click()

    // expect.poll(), not a single read: a non-redirecting Server Action
    // form resolves the click before the mutation is necessarily visible to
    // this test's own Prisma connection (R-008's documented cross-connection
    // lag, e2e/notifications.spec.ts hit the identical shape).
    await expect
      .poll(
        async () => {
          const updated = await prisma.ticket.findUnique({ where: { id: ticket.id } })
          return updated?.priority
        },
        { timeout: 10_000 },
      )
      .toBe('ROUTINE')

    const updated = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(updated.status).toBe('TRIAGED')
    expect(updated.firstResponseAt).not.toBeNull()
  })

  test('resolving as "waiting on tenant" completes the task and updates the ticket', async ({
    page,
  }) => {
    const { ticket, task } = await seedTicket()

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto(`/tasks/${task.id}`)
    await page.getByRole('button', { name: 'Waiting on tenant' }).click()
    await page.waitForURL('**/tasks')

    await expect
      .poll(
        async () => {
          const updated = await prisma.ticket.findUnique({ where: { id: ticket.id } })
          return updated?.status
        },
        { timeout: 10_000 },
      )
      .toBe('WAITING_ON_TENANT')

    const updatedTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } })
    expect(updatedTask.status).toBe('DONE')
    expect(updatedTask.proof).toMatchObject({ resolution: 'waiting_on_tenant' })

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'ticket.triaged', entityId: ticket.id },
    })
    expect(entry.actorType).toBe('STAFF')
  })

  test('converting names R-024 as where dispatch itself ships', async ({ page }) => {
    const { ticket, task } = await seedTicket()

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto(`/tasks/${task.id}`)
    await page.getByRole('button', { name: 'Convert to work order' }).click()
    await page.waitForURL('**/tasks')

    // Same cross-connection lag as the priority test, at the HTTP layer
    // rather than Prisma's: retry the navigation until the server's own read
    // catches up to the write its own redirect just confirmed happened.
    await expect(async () => {
      await page.goto(`/tasks/${task.id}`)
      await expect(page.getByText('Converted to a work order')).toBeVisible()
    }).toPass({ timeout: 10_000 })
    await expect(page.getByText('Work order creation ships in R-024.')).toBeVisible()

    const updated = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(updated.status).toBe('CONVERTED')
  })

  test('merges a duplicate into another open ticket at the same property', async ({ page }) => {
    const { property, unit } = await seedTicket({ category: 'PLUMBING' })
    // A second, independent ticket at the SAME property/unit - the realistic
    // duplicate (two reports of the same leak).
    const tenant2 = await prisma.tenant.create({ data: { firstName: 'Dup', lastName: 'Licate' } })
    tenantIds.push(tenant2.id)
    const lease2 = await prisma.lease.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        status: 'ACTIVE',
        startsOn: new Date('2026-01-01'),
        rentCents: 150_000,
      },
    })
    await prisma.leaseTenant.create({ data: { leaseId: lease2.id, tenantId: tenant2.id } })
    const duplicateTicket = await prisma.ticket.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        leaseId: lease2.id,
        tenantId: tenant2.id,
        source: 'SMS',
        category: 'UNCATEGORIZED',
        description: 'water everywhere in the kitchen',
        priority: 'URGENT',
      },
    })
    ticketIds.push(duplicateTicket.id)
    const duplicateTask = await seedTriageTask(duplicateTicket, property, unit)

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto(`/tasks/${duplicateTask.id}`)

    const originalTicket = await prisma.ticket.findFirstOrThrow({
      where: { propertyId: property.id, category: 'PLUMBING' },
    })
    await page.getByLabel('Merge into').selectOption({ value: originalTicket.id })
    await page.getByRole('button', { name: 'Merge duplicate' }).click()
    await page.waitForURL('**/tasks')

    await expect
      .poll(
        async () => {
          const updated = await prisma.ticket.findUnique({ where: { id: duplicateTicket.id } })
          return updated?.status
        },
        { timeout: 10_000 },
      )
      .toBe('MERGED')

    const updatedDuplicate = await prisma.ticket.findUniqueOrThrow({
      where: { id: duplicateTicket.id },
    })
    expect(updatedDuplicate.mergedIntoTicketId).toBe(originalTicket.id)

    const untouchedOriginal = await prisma.ticket.findUniqueOrThrow({
      where: { id: originalTicket.id },
    })
    expect(untouchedOriginal.status).toBe('NEW')
  })

  test.describe('scoping (ROLE-01)', () => {
    test('a maintenance tech (ticket.read but not ticket.write) sees the ticket with no triage controls', async ({
      page,
    }) => {
      const { property, task } = await seedTicket()

      const staff = await createStaff('maintenance_tech', { propertyId: property.id })
      await signIn(page, staff.email)
      await page.goto(`/tasks/${task.id}`)

      // The ticket's own content is still theirs to read (maintenance_tech
      // holds ticket.read) - what is missing is the ability to change it.
      await expect(page.getByText('Plumbing', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Set priority' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Merge duplicate' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Waiting on tenant' })).toHaveCount(0)
      await expect(page.getByText('Awaiting triage')).toBeVisible()
    })
  })

  test.describe('accessibility', () => {
    test('a triage task detail page has no detectable violations', async ({ page }) => {
      const { task } = await seedTicket({ habitabilityFlag: true })

      const staff = await createStaff('owner')
      await signIn(page, staff.email)
      await page.goto(`/tasks/${task.id}`)

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
      expect(results.violations).toEqual([])
    })
  })
})
