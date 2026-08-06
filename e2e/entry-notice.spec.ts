import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// Scheduling with entry-notice compliance (MAINT-05, COMM-02, D-4, R-027).
//
// The legal gate, exercised against the REAL seeded Texas rule (24 hours)
// read through rulesFor() - not a fixture number. What matters most here is
// what the system refuses to do quietly: schedule a same-day entry without
// anybody stating why.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const ticketIds: string[] = []
const workOrderIds: string[] = []
const noticeIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `entry-${unique}@example.test`,
      name: `Entry Test ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedWorkOrder(options: { priority?: string } = {}) {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Entry LLC-${unique}`, type: 'LLC' },
  })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Entry House-${unique}`,
      addressLine1: '6 Notice Way',
      city: 'Houston',
      // TEXAS on purpose: the seeded jurisdiction rule says 24 hours, and
      // this spec asserts against that real configured value read through
      // rulesFor(), rather than a number it invented for itself.
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Nadia', lastName: `Entry-${unique}`, phone: '+15125556000', email: `t-${unique}@example.test` },
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
      category: 'PLUMBING',
      description: 'Water heater is leaking.',
      priority: 'URGENT',
    },
  })
  ticketIds.push(ticket.id)

  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      ticketId: ticket.id,
      scope: 'Replace the water heater.',
      priority: (options.priority ?? 'URGENT') as never,
      status: 'APPROVED',
    },
  })
  workOrderIds.push(workOrder.id)
  return { property, unit, tenant, workOrder }
}

/// `datetime-local` value N hours from now, in the browser's own local time
/// (the input is naive, and the server parses it the same way).
function localDateTime(hoursFromNow: number): string {
  const at = new Date(Date.now() + hoursFromNow * 3_600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
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
  await prisma.notificationDelivery.deleteMany({
    where: { notification: { propertyId: { in: propertyIds } } },
  })
  await prisma.workOrder.updateMany({
    where: { id: { in: workOrderIds } },
    data: { entryNoticeId: null },
  })
  await prisma.notice.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.workOrder.deleteMany({ where: { id: { in: workOrderIds } } })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.leaseTenant.deleteMany({ where: { tenantId: { in: tenantIds } } })
  await prisma.lease.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.unit.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
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

test.describe('entry-notice compliance', () => {
  test('schedules cleanly with enough notice, and generates the notice', async ({ page }) => {
    const { workOrder, property } = await seedWorkOrder()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/workorders/${workOrder.id}`)
    // The form states the real, configured requirement rather than a guess.
    await expect(page.getByText(/requires 24 hours/)).toBeVisible()

    await page.getByLabel('Window starts').fill(localDateTime(48))
    await page.getByLabel('Window ends').fill(localDateTime(51))
    await page.getByLabel('What the visit is for').fill('Replace the water heater')
    await page.getByRole('button', { name: 'Schedule and notify' }).click()

    await expect
      .poll(
        async () => (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.status,
        { timeout: 15_000 },
      )
      .toBe('SCHEDULED')

    const updated = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(updated.entryOverrideReason, 'no override was needed').toBeNull()
    expect(updated.entryNoticeId).not.toBeNull()

    // The notice itself, tied to the RULE VERSION that produced its period.
    const notice = await prisma.notice.findFirstOrThrow({
      where: { propertyId: property.id, type: 'ENTRY_NOTICE' },
    })
    noticeIds.push(notice.id)
    expect(notice.servedAt).not.toBeNull()
    expect(notice.jurisdictionRuleId).not.toBeNull()
    expect(notice.bodyText).toContain('Replace the water heater')
    // D-4's closing line: every generated legal artifact says what it is.
    expect(notice.bodyText).toContain('not legal advice')

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'notice.served', entityId: notice.id },
    })
    expect(entry.actorType).toBe('STAFF')
  })

  test('REFUSES a same-day window and writes nothing until a reason is given', async ({
    page,
  }) => {
    // The heart of MAINT-05. Two hours' notice against a 24-hour rule.
    const { workOrder } = await seedWorkOrder()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByLabel('Window starts').fill(localDateTime(2))
    await page.getByLabel('Window ends').fill(localDateTime(4))
    await page.getByLabel('What the visit is for').fill('Replace the water heater')
    await page.getByRole('button', { name: 'Schedule and notify' }).click()

    // .first(): the warning legitimately appears twice - once as the form's
    // alert and once as the heading of the override box - and both are the
    // point.
    await expect(page.getByText(/inside the 24-hour notice period/).first()).toBeVisible()
    await expect(page.getByLabel('Why are you going ahead?')).toBeVisible()

    // NOTHING was written - not the window, not a notice. Saving the
    // schedule and asking for the reason afterwards would leave a scheduled
    // unlawful entry on the record if the second step never happened.
    const untouched = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(untouched.scheduledStart).toBeNull()
    expect(untouched.status).toBe('APPROVED')
    expect(await prisma.notice.count({ where: { propertyId: untouched.propertyId } })).toBe(0)
  })

  test('proceeds once a reason is stated, and records it as an override', async ({ page }) => {
    const { workOrder } = await seedWorkOrder()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByLabel('Window starts').fill(localDateTime(2))
    await page.getByLabel('Window ends').fill(localDateTime(4))
    await page.getByLabel('What the visit is for').fill('Replace the water heater')
    await page.getByRole('button', { name: 'Schedule and notify' }).click()

    await expect(page.getByLabel('Why are you going ahead?')).toBeVisible()
    await page
      .getByLabel('Why are you going ahead?')
      .fill('Tenant called this morning asking us to come today - no hot water')
    await page.getByRole('button', { name: /Schedule anyway/ }).click()

    await expect
      .poll(
        async () => (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.status,
        { timeout: 15_000 },
      )
      .toBe('SCHEDULED')

    const updated = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(updated.entryOverrideReason).toContain('no hot water')
    expect(updated.entryOverriddenAt).not.toBeNull()

    // entry_notice.overridden is in REASON_REQUIRED, so recordAudit() itself
    // refuses to write it without the reason - this asserts it landed.
    const override = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'entry_notice.overridden', entityId: workOrder.id },
    })
    expect(override.reason).toContain('no hot water')
    expect((override.after as { requiredHours?: number }).requiredHours).toBe(24)
  })

  test('an EMERGENCY needs no notice and no override', async ({ page }) => {
    // You do not wait 24 hours to enter a unit that is flooding.
    const { workOrder } = await seedWorkOrder({ priority: 'EMERGENCY' })
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/workorders/${workOrder.id}`)
    await expect(page.getByText(/Emergency work order/)).toBeVisible()

    await page.getByLabel('Window starts').fill(localDateTime(1))
    await page.getByLabel('Window ends').fill(localDateTime(3))
    await page.getByLabel('What the visit is for').fill('Active leak')
    await page.getByRole('button', { name: 'Schedule and notify' }).click()

    await expect
      .poll(
        async () => (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.status,
        { timeout: 15_000 },
      )
      .toBe('SCHEDULED')

    const updated = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(updated.entryOverrideReason, 'an emergency is not an override').toBeNull()
    expect(updated.entryNoticeId, 'no notice is generated for an emergency').toBeNull()
  })

  test('logged tenant permission removes the notice requirement', async ({ page }) => {
    const { workOrder } = await seedWorkOrder()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByRole('button', { name: 'Tenant gave permission to enter' }).click()

    await expect
      .poll(
        async () =>
          (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))
            ?.entryPermissionGrantedAt,
        { timeout: 15_000 },
      )
      .not.toBeNull()

    await page.goto(`/workorders/${workOrder.id}`)
    await expect(page.getByText(/given permission to enter/)).toBeVisible()

    await page.getByLabel('Window starts').fill(localDateTime(2))
    await page.getByLabel('Window ends').fill(localDateTime(4))
    await page.getByLabel('What the visit is for').fill('Replace the water heater')
    await page.getByRole('button', { name: 'Schedule and notify' }).click()

    await expect
      .poll(
        async () => (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.status,
        { timeout: 15_000 },
      )
      .toBe('SCHEDULED')

    const updated = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(updated.entryOverrideReason, 'permission is a basis, not an override').toBeNull()
  })

  test('records a tenant no-show as trip-charge evidence', async ({ page }) => {
    const { workOrder } = await seedWorkOrder()
    await prisma.workOrder.update({
      where: { id: workOrder.id },
      data: {
        scheduledStart: new Date(Date.now() - 4 * 3_600_000),
        scheduledEnd: new Date(Date.now() - 2 * 3_600_000),
        status: 'SCHEDULED',
      },
    })
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByRole('button', { name: 'Tenant did not show' }).click()

    await expect
      .poll(
        async () =>
          (await prisma.workOrder.findUnique({ where: { id: workOrder.id } }))?.tenantNoShowAt,
        { timeout: 15_000 },
      )
      .not.toBeNull()

    const updated = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(updated.status).toBe('WAITING_ON_TENANT')
  })
})

test.describe('accessibility', () => {
  test('the scheduling form has no detectable violations', async ({ page }) => {
    const { workOrder } = await seedWorkOrder()
    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/workorders/${workOrder.id}`)

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })
})
