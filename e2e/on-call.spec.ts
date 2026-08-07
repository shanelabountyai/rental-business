import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// After-hours routing through the browser (MAINT-12, NOTIF-05, R-029).
//
// The database-level proofs - the rota narrowing, the chain firing, the
// 24-hour bound - live in apps/web/lib/maintenance/escalation.test.ts. What
// only a browser can prove is here: that a person can actually go on call in
// two taps, and that the acknowledge button on an emergency stops the chain.

const PASSWORD = 'correct-horse-battery-staple'

const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const tenantIds: string[] = []
const ticketIds: string[] = []
const staffIds: string[] = []
const vendorIds: string[] = []

async function seed() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `OnCall LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `OnCall House-${stamp}`,
      addressLine1: '7 Nightwatch Lane',
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
    data: { firstName: 'Rae', lastName: `Night-${stamp}`, phone: '+15125550177' },
  })
  tenantIds.push(tenant.id)

  const staff = await prisma.staffUser.create({
    data: {
      email: `oncall-${randomUUID()}@example.test`,
      name: 'Night Manager',
      phone: '+15125550199',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  // Portfolio-wide rather than scoped to the seeded property: the ticket
  // page opens with an UNSCOPED requirePermission('ticket.read'), which a
  // property-scoped grant does not satisfy. Same shape every other admin
  // spec uses; the property-scoped paging case is covered where it belongs,
  // against the database in lib/maintenance/escalation.test.ts.
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id },
  })

  return { property, unit, tenant, staff }
}

async function makeEmergency(seeded: Awaited<ReturnType<typeof seed>>) {
  const ticket = await prisma.ticket.create({
    data: {
      propertyId: seeded.property.id,
      unitId: seeded.unit.id,
      tenantId: seeded.tenant.id,
      source: 'PORTAL',
      category: 'ACTIVE_FLOODING',
      description: 'EMERGENCY: Water is flooding in right now.',
      priority: 'EMERGENCY',
      status: 'NEW',
      habitabilityFlag: true,
    },
  })
  ticketIds.push(ticket.id)
  return ticket
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
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  // StaffUser rows may be referenced by append-only audit entries, so they
  // are deactivated rather than deleted - the same constraint every spec
  // that audits a staff action runs into.
  await prisma.staffUser.updateMany({
    where: { id: { in: staffIds } },
    data: { active: false },
  })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
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

test.describe('the on-call toggle', () => {
  test('puts somebody on call in two taps, and takes them off again', async ({
    page,
  }) => {
    const { staff } = await seed()
    await signIn(page, staff.email)
    await page.goto('/account')

    await expect(page.getByText(/You are not on call/)).toBeVisible()
    await page.getByRole('button', { name: 'Go on call for 12h' }).click()

    await expect(page.getByText(/You are on call until/)).toBeVisible()
    const during = await prisma.staffUser.findUniqueOrThrow({
      where: { id: staff.id },
      select: { onCallFrom: true, onCallUntil: true },
    })
    // A WINDOW, not a flag - the whole point. A boolean somebody forgets to
    // clear is what makes people mute the channel.
    expect(during.onCallFrom).not.toBeNull()
    expect(during.onCallUntil).not.toBeNull()

    await page.getByRole('button', { name: 'Come off call' }).click()
    await expect(page.getByText(/You are not on call/)).toBeVisible()
    const after = await prisma.staffUser.findUniqueOrThrow({
      where: { id: staff.id },
      select: { onCallUntil: true },
    })
    expect(after.onCallUntil).toBeNull()
  })

  test('records who changed the rota', async ({ page }) => {
    const { staff } = await seed()
    await signIn(page, staff.email)
    await page.goto('/account')
    await page.getByRole('button', { name: 'Go on call for 24h' }).click()
    await expect(page.getByText(/You are on call until/)).toBeVisible()

    await expect
      .poll(() =>
        prisma.auditLog.count({
          where: { entityType: 'StaffUser', entityId: staff.id, action: 'staff.on_call_changed' },
        }),
      )
      .toBeGreaterThan(0)
  })
})

test.describe('the emergency response panel', () => {
  test('acknowledging stops the escalation chain, and says who has it', async ({
    page,
  }) => {
    const seeded = await seed()
    const ticket = await makeEmergency(seeded)
    await signIn(page, seeded.staff.email)
    await page.goto(`/maintenance/${ticket.id}`)

    await expect(page.getByText(/Nobody has acknowledged this yet/)).toBeVisible()
    await page.getByRole('button', { name: 'I have this' }).click()

    await expect(page.getByText(/Acknowledged/)).toBeVisible()
    await expect(page.getByText(/Night Manager/)).toBeVisible()

    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })
    expect(after.acknowledgedAt).not.toBeNull()
    expect(after.acknowledgedByStaffId).toBe(seeded.staff.id)
    // Deliberately NOT firstResponseAt: acknowledging a 3am page is not a
    // triage decision, and letting daytime queue work stop the escalation
    // clock would be the silent failure this item exists to prevent.
    expect(after.firstResponseAt).toBeNull()
  })

  test('shows who answers for the trade, and lets somebody mark them', async ({
    page,
  }) => {
    const seeded = await seed()
    const ticket = await makeEmergency(seeded)
    // A unique number per run: an earlier failed run can leave a vendor
    // behind, and two rows sharing a phone makes the link locator ambiguous.
    const phone = `+1512555${String(Math.floor(Math.random() * 9000) + 1000)}`
    const vendor = await prisma.vendor.create({
      data: {
        name: `Nightshift Plumbing-${randomUUID().slice(0, 6)}`,
        trades: ['plumbing'],
        phone,
      },
    })
    vendorIds.push(vendor.id)

    await signIn(page, seeded.staff.email)
    await page.goto(`/maintenance/${ticket.id}`)

    // Flooding is a plumbing job, and the phone number is a tel: link
    // because the next thing that happens is a call.
    await expect(page.getByRole('heading', { name: /answers for plumbing/i })).toBeVisible()
    await expect(page.getByRole('link', { name: phone })).toHaveAttribute(
      'href',
      `tel:${phone}`,
    )

    await page
      .getByRole('button', { name: new RegExp(`Mark ${vendor.name} as answering`) })
      .click()
    // Scoped to this vendor's own row: the two browser projects run
    // concurrently and each seeds its own plumber, so an unscoped match is
    // ambiguous by construction.
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: vendor.name })
        .getByText('Answers after hours'),
    ).toBeVisible()

    const after = await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })
    expect(after.emergencyAvailable).toBe(true)
  })

  test('is absent from a routine ticket', async ({ page }) => {
    // A panel on every ticket is a panel nobody reads on the one that
    // matters.
    const seeded = await seed()
    const routine = await prisma.ticket.create({
      data: {
        propertyId: seeded.property.id,
        unitId: seeded.unit.id,
        tenantId: seeded.tenant.id,
        source: 'PORTAL',
        category: 'PLUMBING',
        description: 'Dripping tap.',
        priority: 'ROUTINE',
        status: 'NEW',
      },
    })
    ticketIds.push(routine.id)

    await signIn(page, seeded.staff.email)
    await page.goto(`/maintenance/${routine.id}`)
    await expect(page.getByRole('heading', { name: 'Emergency response' })).toHaveCount(0)
  })
})

test.describe('accessibility (§6.4, WCAG 2.1 AA)', () => {
  test('the on-call toggle and the emergency panel have no violations', async ({
    page,
  }) => {
    const seeded = await seed()
    const ticket = await makeEmergency(seeded)
    await signIn(page, seeded.staff.email)

    await page.goto('/account')
    let results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations, 'account').toEqual([])

    await page.goto(`/maintenance/${ticket.id}`)
    results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations, 'emergency panel').toEqual([])
  })
})
