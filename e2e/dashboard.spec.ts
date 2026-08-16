import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { businessDate, businessDateToUtc, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone } from './fixtures.ts'

// The owner's exception-first landing screen (RPT-01, RPT-04, R-050).
//
// ==========================================================================
// THE ONE THING THIS FILE EXISTS TO PROVE: EVERY TILE'S NUMBER MATCHES THE
// ROWS ACTUALLY SHOWN ON ITS DRILL-DOWN. "No dead-end numbers" is R-050's
// own requirement, and a tile that renders a plausible count with no real
// list behind it is exactly the failure mode that requirement names.
//
// Not every tile gets the same depth here. Aged delinquency and collected-
// vs-billed reuse rentRoll()/ordinary ledger reads that already have their
// own e2e coverage (rent-roll.spec.ts); this file's job is the five tiles
// R-050 itself built the wiring for - tickets (the glow clock), vacancies,
// lease expiry, pending approvals, and renewals (a page that had zero
// callers before this item).
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const entityIds: string[] = []
const unitIds: string[] = []
const leaseIds: string[] = []
const ticketIds: string[] = []
const taskIds: string[] = []
const mortgageIds: string[] = []

function daysAgo(n: number): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return new Date(d.toISOString().slice(0, 10) + 'T00:00:00.000Z')
}

function daysFromNow(n: number): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + n)
  return new Date(d.toISOString().slice(0, 10) + 'T00:00:00.000Z')
}

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3_600_000)
}

// `Unit.createdAt` is a real timestamp, read back through `businessDate()`
// (zone-converting), not `utcToBusinessDate()`. THE FENCEPOST THIS FUNCTION
// EXISTS TO AVOID: anchoring "N days ago" to today's UTC CALENDAR DATE, the
// way `daysAgo()` above does, is wrong for several hours a day in a property
// west of UTC - right now, `new Date()`'s UTC date is already tomorrow by
// Chicago's clock. Anchoring to "today" in the PROPERTY'S OWN business date
// instead, and only THEN subtracting N days, keeps this in step with
// whatever `vacantUnits()` computes as "today" when the page renders - the
// same rule the product code itself follows for every date-only read (see
// this repo's own CLAUDE.md on `@db.Date` vs a real timestamp).
function daysAgoAtNoonUtc(n: number): Date {
  const todayInChicago = businessDateToUtc(businessDate(new Date(), 'America/Chicago'))
  todayInChicago.setUTCDate(todayInChicago.getUTCDate() - n)
  return new Date(utcToBusinessDate(todayInChicago) + 'T12:00:00.000Z')
}

async function seedProperty() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({ data: { name: `Dash LLC-${stamp}`, type: 'LLC' } })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Dash House-${stamp}`,
      addressLine1: '1 Dashboard Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)

  // A vacant unit, 14 days on the market by its own createdAt.
  const vacant = await prisma.unit.create({
    data: {
      propertyId: property.id,
      name: `Vacant-${stamp}`,
      status: 'VACANT',
      marketRentCents: 90_000,
      createdAt: daysAgoAtNoonUtc(14),
    },
  })
  unitIds.push(vacant.id)

  // An occupied unit carrying the glowing ticket and the soon-to-expire lease.
  const occupied = await prisma.unit.create({
    data: { propertyId: property.id, name: `Occupied-${stamp}`, status: 'OCCUPIED' },
  })
  unitIds.push(occupied.id)

  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: occupied.id,
      status: 'ACTIVE',
      startsOn: daysAgo(365),
      endsOn: daysFromNow(60), // within the 90-day window
      rentCents: 150_000,
    },
  })
  leaseIds.push(lease.id)
  const tenant = await prisma.tenant.create({
    data: { firstName: `Dash${stamp}`, lastName: 'Tenant', phone: uniquePhone() },
  })
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })

  const ticket = await prisma.ticket.create({
    data: {
      propertyId: property.id,
      unitId: occupied.id,
      source: 'STAFF',
      category: 'other',
      description: `Glowing ticket ${stamp}`,
      priority: 'EMERGENCY',
      status: 'NEW',
      createdAt: hoursAgo(50), // past the 48h glow threshold
    },
  })
  ticketIds.push(ticket.id)

  const task = await prisma.task.create({
    data: {
      propertyId: property.id,
      type: 'workorder_approval',
      subjectType: 'WorkOrder',
      subjectId: `dash-wo-${stamp}`,
      businessDate: businessDateToUtc(businessDate(new Date(), property.timezone)),
      priority: 'ROUTINE',
      status: 'OPEN',
      title: `Approve $500: Dashboard fixture ${stamp}`,
    },
  })
  taskIds.push(task.id)

  const soon = daysFromNow(30)
  const mortgage = await prisma.mortgage.create({
    data: {
      propertyId: property.id,
      lender: `Dash Bank ${stamp}`,
      rateType: 'ARM',
      armAdjustmentDate: soon,
      isBalloon: false,
    },
  })
  mortgageIds.push(mortgage.id)

  return { property, vacant, occupied, lease, ticket, task, mortgage, stamp }
}

async function seedManager(propertyId: string) {
  const email = `dash-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Dashboard Manager',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id, propertyId } })
  return staff
}

async function signIn(page: import('@playwright/test').Page, staff: { email: string }) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.describe('owner dashboard (RPT-01, R-050)', () => {
  test('the tickets tile glows and its number matches the maintenance drill-down', async ({ page }) => {
    const { property } = await seedProperty()
    const staff = await seedManager(property.id)
    await signIn(page, staff)
    await page.goto('/dashboard')

    const tile = page.getByRole('link', { name: /Open tickets/ })
    await expect(tile.getByText('1', { exact: true })).toBeVisible()
    await expect(tile.getByText(/emergency\/urgent open past 48h/)).toBeVisible()

    await tile.click()
    await expect(page).toHaveURL(/\/maintenance\?glowing=1/)
    // The maintenance list card shows the ticket's category and property/unit,
    // not its free-text description - assert what's actually rendered.
    await expect(page.getByText(new RegExp(property.name))).toBeVisible()
  })

  test('the vacancies tile matches the /vacancies drill-down', async ({ page }) => {
    const { property, vacant } = await seedProperty()
    const staff = await seedManager(property.id)
    await signIn(page, staff)
    await page.goto('/dashboard')

    const tile = page.getByRole('link', { name: /Vacancies/ })
    await expect(tile.getByText('1', { exact: true })).toBeVisible()

    await tile.click()
    await expect(page).toHaveURL(/\/vacancies/)
    const row = page.getByRole('link', { name: new RegExp(vacant.name) })
    await expect(row).toBeVisible()
    await expect(row.getByText(/14 days on market/)).toBeVisible()
    await expect(row.getByText('$30.00/day')).toBeVisible() // 90,000 cents rent / 30
  })

  test('the lease-expiry tile matches the /leases drill-down', async ({ page }) => {
    const { property } = await seedProperty()
    const staff = await seedManager(property.id)
    await signIn(page, staff)
    await page.goto('/dashboard')

    const tile = page.getByRole('link', { name: /Leases expiring/ })
    await expect(tile.getByText('1', { exact: true })).toBeVisible()

    await tile.click()
    await expect(page).toHaveURL(/\/leases\?expiresWithin=90/)
    await expect(page.getByText('$1,500.00/mo')).toBeVisible()
  })

  test('the pending-approvals tile matches the /tasks drill-down', async ({ page }) => {
    const { property, task } = await seedProperty()
    const staff = await seedManager(property.id)
    await signIn(page, staff)
    await page.goto('/dashboard')

    const tile = page.getByRole('link', { name: /Pending approvals/ })
    await expect(tile.getByText('1', { exact: true })).toBeVisible()

    await tile.click()
    await expect(page).toHaveURL(/\/tasks\?type=workorder_approval/)
    await expect(page.getByText(task.title)).toBeVisible()
  })

  test('the renewals tile matches the /renewals drill-down — a page with no caller before this item', async ({
    page,
  }) => {
    const { property, mortgage } = await seedProperty()
    const staff = await seedManager(property.id)
    await signIn(page, staff)
    await page.goto('/dashboard')

    const tile = page.getByRole('link', { name: /Renewals & alerts/ })
    await expect(tile.getByText('1', { exact: true })).toBeVisible()

    await tile.click()
    await expect(page).toHaveURL(/\/renewals/)
    await expect(page.getByText(new RegExp(mortgage.lender))).toBeVisible()
    await expect(page.getByText('ARM rate adjustment')).toBeVisible()
  })
})

test.afterAll(async () => {
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.mortgage.deleteMany({ where: { id: { in: mortgageIds } } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.lease.updateMany({ where: { id: { in: leaseIds } }, data: { status: 'ENDED' } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.$disconnect()
})
