import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan } from './fixtures.ts'

// The per-property operating report (RPT-05, R-081a).
//
// The arithmetic is unit-tested in packages/core/metrics/operating.test.ts.
// What this file proves is what only a real request can: that the numbers
// come out of the same pipeline the tax export uses, that the lemon sorts to
// the top, and that vacancy is counted from real lease rows.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const leaseIds: string[] = []
const tenantIds: string[] = []
const workOrderIds: string[] = []
const ticketIds: string[] = []

const YEAR = 2026

async function createStaff(roleKey: string) {
  const email = `operating-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Operating Report Test',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return { ...staff, email }
}

async function seedEntity(label: string) {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `${label} LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  return { entity, stamp }
}

async function seedProperty(entityId: string, name: string) {
  const stamp = randomUUID().slice(0, 8)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${name}-${stamp}`,
      addressLine1: '1 Operating Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
      // Owned since well before the window, so vacancy is not clipped by
      // acquisition and the arithmetic under test is the lease arithmetic.
      acquiredOn: new Date('2019-01-01T00:00:00Z'),
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  unitIds.push(unit.id)
  return { property, unit, stamp }
}

/// A tenancy covering `[movedInOn, movedOutOn)`. Null move-out means still in.
async function seedTenancy(
  propertyId: string,
  unitId: string,
  stamp: string,
  movedInOn: string,
  movedOutOn: string | null,
) {
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Op', lastName: `Test-${stamp}`, email: `op-${stamp}@example.test` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      startsOn: new Date(`${movedInOn}T00:00:00Z`),
      endsOn: movedOutOn ? new Date(`${movedOutOn}T00:00:00Z`) : null,
      rentCents: 145_000,
      rentDueDay: 1,
      status: movedOutOn ? 'ENDED' : 'ACTIVE',
      moveInAt: new Date(`${movedInOn}T17:00:00Z`),
      moveOutAt: movedOutOn ? new Date(`${movedOutOn}T17:00:00Z`) : null,
    },
  })
  leaseIds.push(lease.id)
  return lease
}

/// A closed, paid job. `invoicePaidAt` and `closedAt` are both inside the
/// year so the row exists on either basis.
async function seedJob(
  propertyId: string,
  unitId: string,
  scope: string,
  invoiceCents: number,
  ticketCategory: string | null,
) {
  let ticketId: string | null = null
  if (ticketCategory) {
    const ticket = await prisma.ticket.create({
      data: {
        propertyId,
        unitId,
        category: ticketCategory,
        priority: 'ROUTINE',
        status: 'CONVERTED',
        source: 'STAFF',
        description: scope,
        createdAt: new Date(`${YEAR}-04-01T12:00:00Z`),
      },
    })
    ticketIds.push(ticket.id)
    ticketId = ticket.id
  }
  const job = await prisma.workOrder.create({
    data: {
      propertyId,
      unitId,
      ticketId,
      scope,
      status: 'CLOSED',
      invoiceCents,
      closedAt: new Date(`${YEAR}-04-02T15:00:00Z`),
      invoicePaidAt: new Date(`${YEAR}-04-09T15:00:00Z`),
    },
  })
  workOrderIds.push(job.id)
  return job
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  await prisma.workOrder.deleteMany({ where: { id: { in: workOrderIds } } })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })

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

test.describe('the lemon view', () => {
  test('counts vacant days from real tenancies and puts the worst net first', async ({ page }) => {
    const { entity } = await seedEntity('Lemon')
    const occupied = await seedProperty(entity.id, 'Steady House')
    const lemon = await seedProperty(entity.id, 'Lemon House')

    // Occupied all year, one cheap job.
    await seedTenancy(occupied.property.id, occupied.unit.id, occupied.stamp, '2024-06-01', null)
    await seedJob(occupied.property.id, occupied.unit.id, 'Tap washer', 8_000, 'PLUMBING')

    // Empty for March (out 1 Mar, back in 1 Apr) and expensive.
    await seedTenancy(lemon.property.id, lemon.unit.id, `${lemon.stamp}a`, '2024-01-01', `${YEAR}-03-01`)
    await seedTenancy(lemon.property.id, lemon.unit.id, `${lemon.stamp}b`, `${YEAR}-04-01`, null)
    await seedJob(lemon.property.id, lemon.unit.id, 'Compressor', 480_000, 'HVAC')

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto(`/reports/operating?entity=${entity.id}&year=${YEAR}&basis=accrual`)

    const snapshot = page.getByRole('table', { name: /Per-property operating snapshot/ })

    // Worst net first. Neither has income (no settled payments seeded), so
    // the bigger spender is the bigger loss.
    await expect(snapshot.getByRole('rowheader').first()).toContainText('Lemon House')

    // 1..31 March: the move-out day counts as vacant and the move-in day
    // does not, matching `daysOnMarket`. The cell carries the percentage in
    // a nested span, so this asserts on both halves at once.
    const lemonRow = snapshot.getByRole('row').filter({ hasText: 'Lemon House' })
    await expect(lemonRow.getByRole('cell').nth(4)).toContainText('31')

    const steadyRow = snapshot.getByRole('row').filter({ hasText: 'Steady House' })
    await expect(steadyRow.getByRole('cell').nth(4)).toContainText('0')
  })
})

test.describe('spend by trade', () => {
  test('attributes by the ticket category, and the columns sum to the spend', async ({ page }) => {
    const { entity } = await seedEntity('Trades')
    const { property, unit, stamp } = await seedProperty(entity.id, 'Trades House')
    await seedTenancy(property.id, unit.id, stamp, '2024-01-01', null)

    await seedJob(property.id, unit.id, 'Leak under sink', 30_000, 'PLUMBING')
    await seedJob(property.id, unit.id, 'Second leak', 20_000, 'PLUMBING')
    await seedJob(property.id, unit.id, 'No ticket behind it', 15_000, null)

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto(`/reports/operating?entity=${entity.id}&year=${YEAR}&basis=accrual`)

    const trades = page.getByRole('region', { name: 'Maintenance spend by trade' })
    await expect(trades.getByText('Plumbing · 2 jobs')).toBeVisible()
    await expect(trades.getByText('$500.00')).toBeVisible()

    // Bucketed, never dropped - a total that quietly excludes what it could
    // not classify is one somebody acts on.
    await expect(trades.getByText('Not attributed · 1 job')).toBeVisible()
    await expect(trades.getByText('$150.00')).toBeVisible()
  })
})

test.describe('the monthly P&L', () => {
  test('books a job into the month it happened in, and leaves the rest blank', async ({ page }) => {
    const { entity } = await seedEntity('Monthly')
    const { property, unit, stamp } = await seedProperty(entity.id, 'Monthly House')
    await seedTenancy(property.id, unit.id, stamp, '2024-01-01', null)
    await seedJob(property.id, unit.id, 'April job', 26_000, 'PLUMBING')

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto(`/reports/operating?entity=${entity.id}&year=${YEAR}&basis=accrual`)

    const monthly = page.getByRole('table', { name: /Monthly net per property/ })
    const row = monthly.getByRole('row').filter({ hasText: 'Monthly House' })
    // Jan is index 0 of the data cells and empty; April is index 3.
    await expect(row.getByRole('cell').nth(0)).toHaveText('—')
    await expect(row.getByRole('cell').nth(3)).toHaveText('-$260.00')
  })
})

test.describe('scoping and accessibility', () => {
  test('a report for an entity outside scope shows nothing of it', async ({ page }) => {
    const { entity: theirs } = await seedEntity('Theirs')
    await seedProperty(theirs.id, 'Their House')
    const { entity: mine } = await seedEntity('Mine')
    await seedProperty(mine.id, 'My House')

    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    // An owner has portfolio-wide scope, so this asserts the entity FILTER
    // rather than a permission denial: asking for one entity must not leak
    // the other's houses into the table.
    await page.goto(`/reports/operating?entity=${mine.id}&year=${YEAR}&basis=accrual`)
    const snapshot = page.getByRole('table', { name: /Per-property operating snapshot/ })
    await expect(snapshot.getByRole('rowheader').filter({ hasText: 'My House' })).toBeVisible()
    // SCOPED TO THE REPORT, not the page. The app shell's property/entity
    // switcher legitimately lists every property the actor can reach, so a
    // page-wide assertion here fails against the switcher rather than
    // against a leak - which is exactly what it did the first time.
    await expect(snapshot.getByText('Their House')).toHaveCount(0)
    await expect(
      page.getByRole('table', { name: /Monthly net per property/ }).getByText('Their House'),
    ).toHaveCount(0)
  })

  test('the operating report page has no detectable violations', async ({ page }) => {
    const { entity } = await seedEntity('Axe')
    const { property, unit, stamp } = await seedProperty(entity.id, 'Axe House')
    await seedTenancy(property.id, unit.id, stamp, '2024-01-01', null)
    await seedJob(property.id, unit.id, 'A job', 26_000, 'PLUMBING')

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto(`/reports/operating?entity=${entity.id}&year=${YEAR}&basis=accrual`)

    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})
