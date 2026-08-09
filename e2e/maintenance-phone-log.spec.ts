import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone } from './fixtures.ts'

// Staff-logged (phone-reported) maintenance requests (MAINT-01, D-10, R-022):
// a tenant who calls instead of using the portal must land in the same
// queue, as the same kind of Ticket, as one submitted online or by text.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const ticketIds: string[] = []

async function createStaff(
  roleKey: string,
  scope?: { propertyId?: string; legalEntityId?: string },
) {
  const email = `phonelog-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Phone Log Test',
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

async function seedCaller(propertyName = 'Phonelog House') {
  const entity = await prisma.legalEntity.create({
    data: { name: `Phonelog LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${propertyName}-${randomUUID().slice(0, 8)}`,
      addressLine1: '9 Call Street',
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
    data: { firstName: 'Cara', lastName: `Caller-${randomUUID().slice(0, 6)}`, phone: uniquePhone() },
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
  const leaseTenant = await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })

  return { property, unit, tenant, lease, leaseTenant }
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
  await prisma.leaseTenant.deleteMany({ where: { tenantId: { in: tenantIds } } })
  await prisma.lease.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.unit.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })

  // AuditLog is append-only (trigger-enforced); a staff row an audit entry
  // still references cannot be hard-deleted without the FK update tripping
  // that trigger. Same pattern as documents.spec.ts and jurisdiction.spec.ts:
  // deactivate the audited ones, hard-delete the rest.
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

test.describe('logging a phone-reported request', () => {
  test('creates a PHONE_LOGGED ticket, structurally the same as any other', async ({ page }) => {
    const caller = await seedCaller()
    const { property, unit, tenant } = caller
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/maintenance/new')
    // By value (the leaseTenant id), not by label - "owner" scope is
    // portfolio-wide, so the picker also lists whatever else the dev
    // database has seeded, and only the value is guaranteed unambiguous.
    await page.getByLabel('Who called').selectOption({ value: caller.leaseTenant.id })
    await page.getByLabel('Category').selectOption('PLUMBING')
    await page
      .getByLabel('What they reported')
      .fill('Tenant says the kitchen faucet has been dripping all week.')
    await page.getByLabel('May we enter if they are not home?').selectOption('true')
    await page.getByLabel('Is there a pet at home?').selectOption('false')
    await page.getByRole('button', { name: 'Log request' }).click()

    // NOT /\/maintenance\/.+/ - that also matches the CURRENT url,
    // "/maintenance/new" itself ("new" satisfies ".+"), which would resolve
    // this wait instantly, before the click's own redirect ever happens, and
    // race the ticket-lookup below against a request that has not committed
    // yet.
    await page.waitForURL(/\/maintenance\/(?!new$)[a-z0-9]+$/)
    await expect(page.getByRole('heading', { name: 'Plumbing' })).toBeVisible()

    const ticket = await prisma.ticket.findFirstOrThrow({
      where: { propertyId: property.id },
    })
    ticketIds.push(ticket.id)
    expect(ticket.source).toBe('PHONE_LOGGED')
    expect(ticket.category).toBe('PLUMBING')
    expect(ticket.tenantId).toBe(tenant.id)
    expect(ticket.unitId).toBe(unit.id)
    expect(ticket.entryPermission).toBe(true)
    expect(ticket.petWarning).toBe(false)
    expect(ticket.description).toContain('kitchen faucet has been dripping')

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'Ticket', entityId: ticket.id },
    })
    expect(entry.actorType).toBe('STAFF')

    // And it shows up in the plain list this item also builds. Scoped to
    // this property's own name, not bare "Plumbing" text - "owner" scope is
    // portfolio-wide, and another test's own PLUMBING ticket can legitimately
    // be on the same list at the same time.
    await page.goto('/maintenance')
    await expect(page.getByRole('link', { name: new RegExp(property.name) })).toBeVisible()
  })

  test('flags habitability language exactly as the other intake paths do', async ({ page }) => {
    const caller = await seedCaller()
    const { property } = caller
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/maintenance/new')
    await page.getByLabel('Who called').selectOption({ value: caller.leaseTenant.id })
    await page.getByLabel('Category').selectOption('PLUMBING')
    await page.getByLabel('What they reported').fill('There is sewage backing up into the tub.')
    await page.getByLabel('May we enter if they are not home?').selectOption('true')
    await page.getByLabel('Is there a pet at home?').selectOption('false')
    await page.getByRole('button', { name: 'Log request' }).click()
    // NOT /\/maintenance\/.+/ - that also matches the CURRENT url,
    // "/maintenance/new" itself ("new" satisfies ".+"), which would resolve
    // this wait instantly, before the click's own redirect ever happens, and
    // race the ticket-lookup below against a request that has not committed
    // yet.
    await page.waitForURL(/\/maintenance\/(?!new$)[a-z0-9]+$/)

    const ticket = await prisma.ticket.findFirstOrThrow({ where: { propertyId: property.id } })
    ticketIds.push(ticket.id)
    expect(ticket.habitabilityFlag).toBe(true)
    await expect(page.getByText('Habitability')).toBeVisible()
  })

  test('rejects whitespace-only notes without creating a ticket', async ({ page }) => {
    // Every field the browser marks `required` is filled - a blank one would
    // never leave the browser at all. Whitespace passes HTML5's `required`
    // (it is non-empty text) but fails the server's own trim check
    // (validatePhoneLoggedRequest), which is the boundary this proves.
    const caller = await seedCaller()
    const { property } = caller
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto('/maintenance/new')
    await page.getByLabel('Who called').selectOption({ value: caller.leaseTenant.id })
    await page.getByLabel('Category').selectOption('ELECTRICAL')
    await page.getByLabel('What they reported').fill('   ')
    await page.getByLabel('May we enter if they are not home?').selectOption('true')
    await page.getByLabel('Is there a pet at home?').selectOption('false')
    await page.getByRole('button', { name: 'Log request' }).click()

    await expect(page.getByText('A few things need an answer')).toBeVisible()
    expect(await prisma.ticket.count({ where: { propertyId: property.id } })).toBe(0)
  })

  test.describe('scoping (ROLE-01)', () => {
    test('offers a property-scoped manager only callers at their own property', async ({
      page,
    }) => {
      const { property } = await seedCaller('Out Of Scope House')
      const inScope = await seedCaller('In Scope House')
      const staff = await createStaff('manager', { propertyId: inScope.property.id })
      await signIn(page, staff.email)

      await page.goto('/maintenance/new')
      const options = await page.getByLabel('Who called').locator('option').allTextContents()
      expect(options.some((o) => o.includes(property.name))).toBe(false)
      expect(options.some((o) => o.includes(inScope.property.name))).toBe(true)
    })
  })

  test.describe('accessibility', () => {
    test('the list and log-request pages have no detectable violations', async ({ page }) => {
      const staff = await createStaff('owner')
      await signIn(page, staff.email)

      await page.goto('/maintenance')
      let results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
      expect(results.violations).toEqual([])

      await page.goto('/maintenance/new')
      results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
      expect(results.violations).toEqual([])
    })
  })
})
