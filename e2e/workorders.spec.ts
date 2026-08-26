import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone } from './fixtures.ts'

// Work order creation & assignment (MAINT-03, PROP-06, R-024): from a
// ticket or standalone, scope/priority/estimate, assign to staff or vendor,
// warranty surfacing before dispatch, and the in-house "job list" - which
// IS the Task queue (D-9), the same call R-023 already made for triage.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const ticketIds: string[] = []
const workOrderIds: string[] = []
const taskIds: string[] = []
const vendorIds: string[] = []
const applianceIds: string[] = []

async function createStaff(
  roleKey: string,
  scope?: { propertyId?: string; legalEntityId?: string },
) {
  const unique = randomUUID().slice(0, 8)
  const email = `wo-${unique}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      // Unique per call, not a fixed string - the "assign to staff" picker
      // is portfolio-wide for an owner, and two staff sharing one display
      // name makes selectOption({label}) pick whichever the browser
      // happens to resolve first, not necessarily the one this test means.
      name: `Work Order Test ${unique}`,
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

async function seedPropertyAndUnit(propertyName = 'WO House') {
  const entity = await prisma.legalEntity.create({
    data: { name: `WO LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${propertyName}-${randomUUID().slice(0, 8)}`,
      addressLine1: '7 Dispatch Drive',
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
  return { property, unit }
}

async function seedConvertedTicket(propertyId: string, unitId: string, category = 'HVAC') {
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Wo', lastName: `Tenant-${randomUUID().slice(0, 6)}`, phone: uniquePhone() },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })

  const ticket = await prisma.ticket.create({
    data: {
      propertyId,
      unitId,
      leaseId: lease.id,
      tenantId: tenant.id,
      source: 'PORTAL',
      category,
      description: 'The AC is blowing warm air.',
      priority: 'URGENT',
      status: 'NEW',
    },
  })
  ticketIds.push(ticket.id)

  // The triage task R-023's own consumer would create - seeded directly
  // (that wiring is R-023's own coverage), so this spec can prove the
  // "reaching creation directly closes the still-open triage task" behavior
  // without dispatching the outbox itself.
  const task = await prisma.task.create({
    data: {
      propertyId,
      type: 'ticket_triage',
      subjectType: 'Ticket',
      subjectId: ticket.id,
      businessDate: new Date(new Date().toISOString().slice(0, 10)),
      priority: 'URGENT',
      title: `Triage: HVAC — test`,
    },
  })
  taskIds.push(task.id)

  return { ticket, tenant }
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
  await prisma.eventConsumption.deleteMany({ where: { event: { propertyId: { in: propertyIds } } } })
  await prisma.outboxEvent.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } })
  await prisma.appliance.deleteMany({ where: { id: { in: applianceIds } } })
  await prisma.workOrder.deleteMany({ where: { id: { in: workOrderIds } } })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.leaseTenant.deleteMany({ where: { tenantId: { in: tenantIds } } })
  await prisma.lease.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.unit.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } })
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

test.describe('creating a work order', () => {
  test('standalone (no ticket) creates a SUBMITTED work order', async ({ page }) => {
    const { property, unit } = await seedPropertyAndUnit()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/workorders/new')
    await page.getByLabel('Unit').selectOption({ label: `${property.name} — ${unit.name}` })
    await page.getByLabel('Scope of work').fill('Turn the unit: paint, clean, replace blinds.')
    await page.getByLabel('Priority').selectOption('ROUTINE')
    await page.getByLabel('Cost estimate (optional)').fill('450')
    await page.getByRole('button', { name: 'Create work order' }).click()

    await page.waitForURL(/\/workorders\/(?!new$)[a-z0-9]+$/)
    await expect(page.getByText('Turn the unit', { exact: false })).toBeVisible()

    const workOrder = await prisma.workOrder.findFirstOrThrow({ where: { unitId: unit.id } })
    workOrderIds.push(workOrder.id)
    expect(workOrder.status).toBe('SUBMITTED')
    expect(workOrder.estimateCents).toBe(45_000)
    expect(workOrder.ticketId).toBeNull()
  })

  test('from a ticket converts it and closes its still-open triage task', async ({ page }) => {
    const { property, unit } = await seedPropertyAndUnit()
    const { ticket, tenant } = await seedConvertedTicket(property.id, unit.id, 'HVAC')
    await prisma.warranty.create({
      data: { propertyId: property.id, category: 'HVAC', provider: 'CoolCo', expiresOn: null },
    })

    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/workorders/new?ticketId=${ticket.id}`)
    await expect(page.getByText('CoolCo', { exact: false })).toBeVisible()
    await expect(page.getByText('likely covers this')).toBeVisible()

    await page.getByLabel('Scope of work').fill('Diagnose and repair the AC unit.')
    await page.getByLabel('Priority').selectOption('URGENT')
    await page.getByRole('button', { name: 'Create work order' }).click()
    await page.waitForURL(/\/workorders\/(?!new$)[a-z0-9]+$/)

    const workOrder = await prisma.workOrder.findFirstOrThrow({ where: { ticketId: ticket.id } })
    workOrderIds.push(workOrder.id)

    await expect
      .poll(async () => (await prisma.ticket.findUnique({ where: { id: ticket.id } }))?.status, {
        timeout: 10_000,
      })
      .toBe('CONVERTED')

    const triageTask = await prisma.task.findFirstOrThrow({
      where: { type: 'ticket_triage', subjectId: ticket.id },
    })
    expect(triageTask.status).toBe('DONE')
  })

  test('rejects an empty scope without creating a work order', async ({ page }) => {
    const { property, unit } = await seedPropertyAndUnit()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/workorders/new')
    await page.getByLabel('Unit').selectOption({ label: `${property.name} — ${unit.name}` })
    await page.getByLabel('Scope of work').fill('   ')
    await page.getByRole('button', { name: 'Create work order' }).click()

    await expect(page.getByText('Fix the highlighted fields.')).toBeVisible()
    expect(await prisma.workOrder.count({ where: { unitId: unit.id } })).toBe(0)
  })
})

test.describe('assigning a work order', () => {
  test('to staff moves it to ASSIGNED with that tech recorded', async ({ page }) => {
    // The Task itself is created by the workorder.assigned outbox consumer,
    // not synchronously by this action - proved against the real consumer
    // in job-consumer.test.ts (same reasoning e2e/triage.spec.ts's own
    // header gives for why R-023's e2e seeds the Task directly rather than
    // dispatching cron: /api/cron also runs R-009's own job for every
    // property in the database, which collides with e2e's own batch
    // property deletes in a way that is that item's bug to fix, not this
    // one's to trigger). This test proves the assignment itself; the next
    // one proves what a tech sees once a job Task exists, seeded directly.
    const { property, unit } = await seedPropertyAndUnit()
    const workOrder = await prisma.workOrder.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        scope: 'Diagnose and repair the AC unit.',
        priority: 'URGENT',
      },
    })
    workOrderIds.push(workOrder.id)

    const owner = await createStaff('owner')
    const tech = await createStaff('maintenance_tech', { propertyId: property.id })
    await signIn(page, owner.email)

    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByLabel('Assign to staff').selectOption({ label: tech.name })
    await page.getByRole('button', { name: 'Assign to staff' }).click()

    await expect
      .poll(
        async () => (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.status,
        { timeout: 10_000 },
      )
      .toBe('ASSIGNED')
    const updated = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(updated.assignedStaffId).toBe(tech.id)

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'workorder.assigned', entityId: workOrder.id },
    })
    expect(entry.actorType).toBe('STAFF')
  })

  test('a job Task carries full context to the assigned tech', async ({ page }) => {
    const { property, unit } = await seedPropertyAndUnit()
    const { ticket, tenant } = await seedConvertedTicket(property.id, unit.id, 'HVAC')
    const appliance = await prisma.appliance.create({
      data: { unitId: unit.id, category: 'HVAC', make: 'Carrier', model: 'X200', filterSize: '16x25x1' },
    })
    applianceIds.push(appliance.id)

    const workOrder = await prisma.workOrder.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        ticketId: ticket.id,
        scope: 'Diagnose and repair the AC unit.',
        priority: 'URGENT',
        status: 'ASSIGNED',
      },
    })
    workOrderIds.push(workOrder.id)

    const tech = await createStaff('maintenance_tech', { propertyId: property.id })
    const jobTask = await prisma.task.create({
      data: {
        propertyId: property.id,
        type: 'workorder_job',
        subjectType: 'WorkOrder',
        subjectId: workOrder.id,
        businessDate: new Date(new Date().toISOString().slice(0, 10)),
        priority: 'URGENT',
        assigneeStaffId: tech.id,
        title: `Job: ${workOrder.scope} — ${unit.name}`,
      },
    })
    taskIds.push(jobTask.id)

    await signIn(page, tech.email)
    await page.goto(`/tasks/${jobTask.id}`)
    await expect(page.getByText('Carrier', { exact: false })).toBeVisible()
    await expect(page.getByText('16x25x1', { exact: false })).toBeVisible()
    await expect(page.getByText(tenant.phone!)).toBeVisible()
  })

  test('to a vendor does not create a job Task - a vendor has no queue to claim from', async ({
    page,
  }) => {
    const { property, unit } = await seedPropertyAndUnit()
    const vendor = await prisma.vendor.create({
      data: { name: `Cool Air Co-${randomUUID().slice(0, 6)}`, trades: ['hvac'], active: true },
    })
    vendorIds.push(vendor.id)

    const workOrder = await prisma.workOrder.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        scope: 'Repair the compressor.',
        priority: 'URGENT',
      },
    })
    workOrderIds.push(workOrder.id)

    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/workorders/${workOrder.id}`)
    // By value, not label (R-079): the picker now appends "no W-9"/"COI
    // expired" warnings onto a vendor's label, so an exact-label match
    // against the bare name no longer resolves. The option's value is
    // always the vendor's own id (see AssignForm).
    await page.getByLabel('Assign to vendor').selectOption({ value: vendor.id })
    await page.getByRole('button', { name: 'Assign to vendor' }).click()

    await expect
      .poll(
        async () => (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.vendorId,
        { timeout: 10_000 },
      )
      .toBe(vendor.id)

    const count = await prisma.task.count({
      where: { type: 'workorder_job', subjectId: workOrder.id },
    })
    expect(count).toBe(0)
  })
})

test.describe('warranty hold', () => {
  test('puts a work order on hold and resumes it', async ({ page }) => {
    const { property, unit } = await seedPropertyAndUnit()
    const workOrder = await prisma.workOrder.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        scope: 'Replace the water heater.',
        priority: 'URGENT',
        warrantyClaim: true,
      },
    })
    workOrderIds.push(workOrder.id)

    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByRole('button', { name: 'Put on hold for warranty claim' }).click()

    await expect
      .poll(
        async () => (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.status,
        { timeout: 10_000 },
      )
      .toBe('ON_HOLD_WARRANTY')

    await expect(async () => {
      await page.goto(`/workorders/${workOrder.id}`)
      await expect(page.getByRole('button', { name: 'Resume from warranty hold' })).toBeVisible()
    }).toPass({ timeout: 10_000 })

    await page.getByRole('button', { name: 'Resume from warranty hold' }).click()
    await expect
      .poll(
        async () => (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.status,
        { timeout: 10_000 },
      )
      .toBe('SUBMITTED')
  })
})

test.describe('scoping (ROLE-01)', () => {
  test('offers a property-scoped manager only units at their own property', async ({ page }) => {
    const { property } = await seedPropertyAndUnit('Out Of Scope House')
    const inScope = await seedPropertyAndUnit('In Scope House')
    const staff = await createStaff('manager', { propertyId: inScope.property.id })
    await signIn(page, staff.email)

    await page.goto('/workorders/new')
    const options = await page.getByLabel('Unit').locator('option').allTextContents()
    expect(options.some((o) => o.includes(property.name))).toBe(false)
    expect(options.some((o) => o.includes(inScope.property.name))).toBe(true)
  })
})

test.describe('accessibility', () => {
  test('the list, new, and detail pages have no detectable violations', async ({ page }) => {
    // THREE full axe scans in one test, and the third is the work-order detail
    // page - a dozen panels contributed by a dozen items, and the heaviest
    // page in the product. MEASURED AT 42.3s (desktop) and 42.5s (mobile) on
    // an idle machine, against the config's 60s default: 70% of the deadline
    // gone before any contention at all. It duly exceeded 60s under a full
    // sweep with five workers, on both attempts, and reported as a failure in
    // `page.evaluate` that reads like an axe problem rather than a budget one.
    //
    // CLAUDE.md's rule, and the fourth time this shape has been diagnosed
    // here: a timeout set at the measured cost is a flake generator. The
    // measurement is written here so the next person raising it knows what
    // they are raising it from.
    test.setTimeout(180_000)

    const { unit } = await seedPropertyAndUnit()
    const workOrder = await prisma.workOrder.create({
      data: {
        propertyId: unit.propertyId,
        unitId: unit.id,
        scope: 'Accessibility check work order.',
        priority: 'ROUTINE',
      },
    })
    workOrderIds.push(workOrder.id)

    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/workorders')
    let results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations).toEqual([])

    await page.goto('/workorders/new')
    results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations).toEqual([])

    await page.goto(`/workorders/${workOrder.id}`)
    results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })
})
