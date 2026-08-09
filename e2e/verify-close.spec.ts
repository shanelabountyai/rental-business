import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { hashPassword, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone } from './fixtures.ts'

// Verify & close through the browser (MAINT-07, R-030).
//
// The two halves that only a browser proves: a tenant can answer in one tap
// from their own portal, and a PM cannot close a job the tenant has just said
// is not fixed. The attribution rule that makes the reopen-rate honest is
// proved against the database in lib/workorders/verify.test.ts, where it
// belongs.

const PASSWORD = 'correct-horse-battery-staple'

const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const tenantIds: string[] = []
const ticketIds: string[] = []
const workOrderIds: string[] = []
const staffIds: string[] = []
const vendorIds: string[] = []

async function seed(options: { status?: string } = {}) {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Vfy LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Vfy House-${stamp}`,
      addressLine1: '19 Verify Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  unitIds.push(unit.id)

  const tenant = await prisma.tenant.create({
    data: { firstName: 'Nel', lastName: `Verify-${stamp}`, phone: uniquePhone() },
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
      tenantId: tenant.id,
      source: 'PORTAL',
      category: 'PLUMBING',
      description: 'The kitchen tap will not stop dripping.',
      priority: 'ROUTINE',
      status: 'CONVERTED',
    },
  })
  ticketIds.push(ticket.id)

  const vendor = await prisma.vendor.create({
    data: { name: `Vfy Plumbing-${stamp}`, trades: ['plumbing'], phone: uniquePhone() },
  })
  vendorIds.push(vendor.id)

  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      ticketId: ticket.id,
      vendorId: vendor.id,
      scope: 'Replace the tap cartridge',
      status: (options.status ?? 'WORK_COMPLETE') as never,
      completedAt: new Date(),
      actualLaborCents: 9_000,
      actualMaterialsCents: 2_500,
    },
  })
  workOrderIds.push(workOrder.id)

  const staff = await prisma.staffUser.create({
    data: {
      email: `vfy-${randomUUID()}@example.test`,
      name: 'Verify Manager',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
  // Portfolio-wide: the work order page opens with an unscoped
  // requirePermission, which a property-scoped grant does not satisfy.
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id },
  })

  return { property, unit, tenant, ticket, workOrder, vendor, staff }
}

async function magicLinkFor(tenantId: string) {
  const minted = mintToken('TENANT_MAGIC_LINK')
  await prisma.authToken.create({
    data: {
      purpose: 'TENANT_MAGIC_LINK',
      tokenHash: minted.tokenHash,
      subjectType: 'Tenant',
      subjectId: tenantId,
      expiresAt: minted.expiresAt,
    },
  })
  return `/portal/verify?token=${minted.token}`
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
  await prisma.workOrderVerification.deleteMany({
    where: { workOrderId: { in: workOrderIds } },
  })
  await prisma.notificationDelivery.deleteMany({
    where: { notification: { recipientId: { in: tenantIds } } },
  })
  await prisma.task.deleteMany({ where: { subjectId: { in: workOrderIds } } })
  await prisma.workOrder.deleteMany({ where: { id: { in: workOrderIds } } })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.leaseTenant.deleteMany({ where: { tenantId: { in: tenantIds } } })
  await prisma.lease.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  // Deactivated, not deleted: closing writes an audit row against the
  // property and AuditLog refuses the cascading update.
  await prisma.staffUser.updateMany({
    where: { id: { in: staffIds } },
    data: { active: false },
  })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })
  await prisma.tenant.updateMany({
    where: { id: { in: tenantIds } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

test.describe('the tenant answers', () => {
  test('one tap says it is fixed, and the job moves to verified', async ({ page }) => {
    const { tenant, ticket, workOrder, vendor } = await seed()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto(`/portal/maintenance/${ticket.id}`)

    await expect(page.getByRole('heading', { name: 'Is it fixed?' })).toBeVisible()
    await page.getByRole('button', { name: 'Yes, it is fixed' }).click()
    await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible()

    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(after.status).toBe('VERIFIED')
    expect(after.verifiedAt).not.toBeNull()

    const verification = await prisma.workOrderVerification.findFirstOrThrow({
      where: { workOrderId: workOrder.id },
    })
    expect(verification.resolved).toBe(true)
    expect(verification.round).toBe(1)
    // The vendor is captured on the answer, not read off the work order
    // later - the whole point of MAINT-07's "from day one".
    expect(verification.vendorId).toBe(vendor.id)
  })

  test('carries a rating and a comment when the tenant gives them', async ({ page }) => {
    const { tenant, ticket, workOrder } = await seed()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto(`/portal/maintenance/${ticket.id}`)

    await page.getByRole('button', { name: '4', exact: true }).click()
    await page.getByLabel(/Anything we should know/).fill('Quick and tidy.')
    await page.getByRole('button', { name: 'Yes, it is fixed' }).click()
    await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible()

    const verification = await prisma.workOrderVerification.findFirstOrThrow({
      where: { workOrderId: workOrder.id },
    })
    expect(verification.rating).toBe(4)
    expect(verification.comment).toBe('Quick and tidy.')
  })

  test('"no" reopens the job and raises a task, without a second report', async ({
    page,
  }) => {
    const { tenant, ticket, workOrder } = await seed()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto(`/portal/maintenance/${ticket.id}`)

    await page.getByLabel(/Anything we should know/).fill('Still dripping.')
    await page.getByRole('button', { name: 'No, it is not' }).click()
    await expect(page.getByText(/reopened it/i)).toBeVisible()

    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(after.status).toBe('SUBMITTED')
    expect(after.reopenCount).toBe(1)
    expect(after.reopenedAt).not.toBeNull()
    // Cleared, because it is no longer true - a stale completion stamp on a
    // job the tenant has contradicted would read as a sign-off.
    expect(after.completedAt).toBeNull()
    // The vendor is deliberately NOT cleared: the PM needs to see whose work
    // came back while deciding who to send.
    expect(after.vendorId).not.toBeNull()

    await expect
      .poll(() =>
        prisma.task.count({
          where: { subjectId: workOrder.id, type: 'workorder_reopened' },
        }),
      )
      .toBe(1)
  })

  test('is not asked about a job that is not finished', async ({ page }) => {
    const { tenant, ticket } = await seed({ status: 'IN_PROGRESS' })
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto(`/portal/maintenance/${ticket.id}`)

    await expect(page.getByRole('heading', { name: 'Is it fixed?' })).toHaveCount(0)
  })

  test('cannot answer for somebody else’s repair', async ({ page }) => {
    // The guard is against the TICKET's tenant, because a work order has no
    // tenant column. Getting it wrong would let one tenant reopen another's
    // job.
    const mine = await seed()
    const theirs = await seed()

    await page.goto(await magicLinkFor(mine.tenant.id))
    await page.goto(`/portal/maintenance/${theirs.ticket.id}`)
    // Not yours and does not exist are indistinguishable.
    await expect(page.getByRole('heading', { name: 'Is it fixed?' })).toHaveCount(0)

    const untouched = await prisma.workOrder.findUniqueOrThrow({
      where: { id: theirs.workOrder.id },
    })
    expect(untouched.status).toBe('WORK_COMPLETE')
  })
})

test.describe('the PM closes', () => {
  test('REFUSES to close over a tenant saying it is not fixed', async ({ page }) => {
    // The single worst outcome this item can produce: a live complaint
    // recorded as resolved is what a tenant later shows a judge.
    const { tenant, ticket, workOrder, staff } = await seed()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto(`/portal/maintenance/${ticket.id}`)
    await page.getByRole('button', { name: 'No, it is not' }).click()
    await expect(page.getByText(/reopened it/i)).toBeVisible()

    // Put it back to complete so the close screen is reachable, WITHOUT
    // clearing the tenant's answer - which is exactly the situation the
    // refusal exists for.
    await prisma.workOrder.update({
      where: { id: workOrder.id },
      data: { status: 'WORK_COMPLETE', reopenCount: 0 },
    })

    await signIn(page, staff.email)
    await page.goto(`/workorders/${workOrder.id}`)
    await expect(page.getByText(/The tenant says this is NOT fixed/)).toBeVisible()

    await page.getByRole('button', { name: 'Close this work order' }).click()
    await expect(page.getByText(/would record a live complaint as resolved/)).toBeVisible()

    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(after.status).not.toBe('CLOSED')
  })

  test('closes with the invoice, and that number is the property’s spend', async ({
    page,
  }) => {
    // The chain: typed once here, read everywhere else. No re-keying is the
    // whole requirement.
    const { tenant, ticket, workOrder, property, staff } = await seed()
    await page.goto(await magicLinkFor(tenant.id))
    await page.goto(`/portal/maintenance/${ticket.id}`)
    await page.getByRole('button', { name: 'Yes, it is fixed' }).click()
    await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible()

    await signIn(page, staff.email)
    await page.goto(`/workorders/${workOrder.id}`)
    await expect(page.getByText(/The tenant confirmed this is fixed/)).toBeVisible()

    await page.getByLabel(/Invoice total/).fill('215')
    await page.getByRole('button', { name: 'Close this work order' }).click()
    await expect(page.getByRole('heading', { name: 'Closed' })).toBeVisible()
    await expect(page.getByText(/The tenant confirmed this was fixed/)).toBeVisible()

    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(after.status).toBe('CLOSED')
    expect(after.invoiceCents).toBe(21_500)
    expect(after.closedByStaffId).toBe(staff.id)

    // The same number, on the property, with nobody having typed it twice.
    await page.goto(`/properties/${property.id}`)
    await expect(page.getByRole('heading', { name: 'Maintenance spend' })).toBeVisible()
    await expect(page.getByText('$215.00').first()).toBeVisible()
  })

  test('refuses a $0 close unless somebody says it was free', async ({ page }) => {
    const { workOrder, staff } = await seed()
    await prisma.workOrder.update({
      where: { id: workOrder.id },
      data: { actualLaborCents: null, actualMaterialsCents: null },
    })

    await signIn(page, staff.email)
    await page.goto(`/workorders/${workOrder.id}`)
    await page.getByRole('button', { name: 'Close this work order' }).click()
    await expect(page.getByText(/Record what this cost/)).toBeVisible()

    await page.getByLabel(/This job cost nothing/).check()
    await page.getByRole('button', { name: 'Close this work order' }).click()
    await expect(page.getByRole('heading', { name: 'Closed' })).toBeVisible()

    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(after.status).toBe('CLOSED')
  })

  test('says so when it closes a job the tenant never answered', async ({ page }) => {
    // A silent tenant must not hold a work order open forever - but the PM
    // signs for that, and the record says so afterwards.
    const { workOrder, staff } = await seed()
    await signIn(page, staff.email)
    await page.goto(`/workorders/${workOrder.id}`)

    await expect(page.getByText(/has not answered yet/)).toBeVisible()
    await page.getByRole('button', { name: 'Close this work order' }).click()
    // On the record, not in a toast - this is the caveat somebody needs to
    // see months later.
    await expect(page.getByText(/The tenant never confirmed this one/)).toBeVisible()

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: workOrder.id, action: 'workorder.closed' },
    })
    expect((entry.after as { unverified?: boolean })?.unverified).toBe(true)
  })

  test('marks the job tenant-caused when the PM says so', async ({ page }) => {
    const { workOrder, staff } = await seed()
    await signIn(page, staff.email)
    await page.goto(`/workorders/${workOrder.id}`)

    await page.getByLabel('Tenant-caused').check()
    await page.getByRole('button', { name: 'Close this work order' }).click()
    await expect(page.getByRole('heading', { name: 'Closed' })).toBeVisible()

    const after = await prisma.workOrder.findUniqueOrThrow({ where: { id: workOrder.id } })
    expect(after.tenantCaused).toBe(true)
  })
})

test.describe('accessibility (§6.4, WCAG 2.1 AA)', () => {
  test('the tenant question and the close panel have no violations', async ({ page }) => {
    const { tenant, ticket, workOrder, staff } = await seed()

    await page.goto(await magicLinkFor(tenant.id))
    await page.goto(`/portal/maintenance/${ticket.id}`)
    let results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations, 'tenant question').toEqual([])

    await signIn(page, staff.email)
    await page.goto(`/workorders/${workOrder.id}`)
    results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations, 'close panel').toEqual([])
  })
})
