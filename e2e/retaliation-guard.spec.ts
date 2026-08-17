import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone } from './fixtures.ts'

// The retaliation-claim guard, through the browser (RISK-06, R-055).
//
// The decision logic is proved exhaustively in
// packages/core/leases/retaliation.test.ts and the database query in
// apps/web/lib/leases/retaliation-check.test.ts. What only a browser proves
// is here: that raising rent or giving notice inside the window actually
// blocks the save, shows the specific complaint, and that "save anyway"
// requires and records a reason - against the REAL seeded Texas window (180
// days), not a fixture number.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []
const ticketIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `retaliation-${unique}@example.test`,
      name: `Retaliation Test ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedActiveLease(options: { habitabilityDaysAgo?: number } = {}) {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Retaliation LLC-${unique}`, type: 'LLC' },
  })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Retaliation House-${unique}`,
      addressLine1: '12 Presumption Place',
      city: 'Houston',
      // TEXAS ON PURPOSE: the seeded rule's retaliationWindowDays (180) is
      // the real configured value, read through rulesFor() - not a fixture
      // this spec invented for itself.
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
  unitIds.push(unit.id)
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Priya',
      lastName: `Retaliation-${unique}`,
      email: `priya-${unique}@example.test`,
      phone: uniquePhone(),
    },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      isMonthToMonth: true,
      rentCents: 150_000,
      depositCents: 150_000,
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })

  if (options.habitabilityDaysAgo != null) {
    const ticket = await prisma.ticket.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        leaseId: lease.id,
        tenantId: tenant.id,
        source: 'PORTAL',
        category: 'no heat',
        description: 'The furnace is not working.',
        habitabilityFlag: true,
        createdAt: new Date(Date.now() - options.habitabilityDaysAgo * 24 * 60 * 60 * 1000),
      },
    })
    ticketIds.push(ticket.id)
  }

  return { property, unit, tenant, lease }
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The redirect on success is a server action's `redirect()`, resolved
  // client-side after an async round trip - `.click()` itself resolves the
  // instant the click is dispatched, well before that. Without this, the
  // very next `page.goto` in every test here raced the sign-in and lost,
  // landing back on /login and timing out on a field that was never there.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

test.afterAll(async () => {
  await prisma.auditLog.deleteMany({
    where: { action: 'lease.retaliation_window_acknowledged', entityId: { in: leaseIds } },
  }).catch(() => {
    // AuditLog is append-only; this is best-effort tidiness in a test
    // database, not something the trigger will actually allow if it fails.
  })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('a rent increase inside the window is blocked, warns with the specific complaint, and requires a reason to proceed', async ({
  page,
}) => {
  const staff = await createStaff()
  const { lease } = await seedActiveLease({ habitabilityDaysAgo: 30 })

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)

  await page.getByLabel('Monthly rent (dollars)').fill('1800')
  await page.getByRole('button', { name: 'Save terms' }).click()

  // The specific complaint and date, not a generic refusal (RISK-06's own
  // wording: "warns... with the specific complaint and date").
  await expect(page.getByText(/30 days after this tenant.s no heat complaint/)).toBeVisible()
  await expect(page.getByLabel('Why are you raising rent now?')).toBeVisible()

  // NOTHING was written yet.
  await expect.poll(async () => (await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })).rentCents).toBe(150_000)

  await page
    .getByLabel('Why are you raising rent now?')
    .fill('Portfolio-wide increase to match market rent, unrelated to the furnace repair.')
  await page.getByRole('button', { name: /Save anyway/ }).click()

  await expect(page.getByText('Saved.')).toBeVisible()
  await expect.poll(async () => (await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })).rentCents).toBe(180_000)

  const audited = await prisma.auditLog.findFirst({
    where: { action: 'lease.retaliation_window_acknowledged', entityId: lease.id },
  })
  expect(audited).not.toBeNull()
  expect(audited?.reason).toContain('Portfolio-wide increase')
  expect((audited?.after as { complaintTicketId?: string })?.complaintTicketId).toBeTruthy()
})

test('a rent increase with no recent complaint saves immediately, no warning', async ({ page }) => {
  const staff = await createStaff()
  const { lease } = await seedActiveLease()

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)

  await page.getByLabel('Monthly rent (dollars)').fill('1700')
  await page.getByRole('button', { name: 'Save terms' }).click()

  await expect(page.getByText('Saved.')).toBeVisible()
  await expect(page.getByLabel('Why are you raising rent now?')).toHaveCount(0)
})

test('the landlord giving notice inside the window is blocked and requires a reason; the tenant giving notice is not', async ({
  page,
}) => {
  const staff = await createStaff()
  const { lease } = await seedActiveLease({ habitabilityDaysAgo: 10 })

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)

  await page.getByText('Record notice to end the tenancy').click()
  await page.getByLabel('Who gave notice').selectOption('LANDLORD')
  await page.getByLabel('Date notice was given').fill('2026-08-17')
  await page.getByRole('button', { name: 'Record notice' }).click()

  // NOT a pinned day count: `givenOn` is a fixed UTC-midnight calendar date
  // (parseLeaseDate) while the ticket's `createdAt` is seeded from wall-clock
  // "now" - the two can differ by a day depending on what time this spec
  // happens to run, and the exact arithmetic is already pinned precisely in
  // packages/core/leases/retaliation.test.ts. What matters here is that the
  // SPECIFIC complaint and its category actually appear (RISK-06's own
  // wording), not the exact day count.
  await expect(page.getByText(/\d+ days? after this tenant.s no heat complaint/)).toBeVisible()

  await expect.poll(async () => (await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })).noticeGivenAt).toBeNull()

  await page
    .getByLabel('Why is this notice going out now?')
    .fill('Owner is moving a family member into the unit.')
  await page.getByRole('button', { name: /Record notice anyway/ }).click()

  await expect.poll(async () => (await prisma.lease.findUniqueOrThrow({ where: { id: lease.id } })).noticeGivenAt).not.toBeNull()

  const audited = await prisma.auditLog.findFirst({
    where: { action: 'lease.retaliation_window_acknowledged', entityId: lease.id },
  })
  expect(audited).not.toBeNull()
})

test('the tenant giving their own notice is never a retaliation claim', async ({ page }) => {
  const staff = await createStaff()
  const { lease } = await seedActiveLease({ habitabilityDaysAgo: 10 })

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)

  await page.getByText('Record notice to end the tenancy').click()
  await page.getByLabel('Who gave notice').selectOption('TENANT')
  await page.getByLabel('Date notice was given').fill('2026-08-17')
  await page.getByRole('button', { name: 'Record notice' }).click()

  // A successful notice swaps the whole form for the "still running" summary
  // (LifecyclePanel's own underNotice branch) - the same UI leases.spec.ts's
  // own notice test asserts against, rather than a transient success banner
  // that this transition never actually renders.
  await expect(page.getByText(/still running until it ends/)).toBeVisible()
  await expect(page.getByText(/retaliation-presumption window/)).toHaveCount(0)

  const audited = await prisma.auditLog.findFirst({
    where: { action: 'lease.retaliation_window_acknowledged', entityId: lease.id },
  })
  expect(audited).toBeNull()
})
