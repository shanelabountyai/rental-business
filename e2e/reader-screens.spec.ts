import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { normalizePhone } from '@rental/core/comms'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone, uniqueStateCode } from './fixtures.ts'

// R-148: the remaining "readers with no screen" from R-145's list, each now
// rendered somewhere - jurisdiction version history on /jurisdiction,
// access-code history on the unit page, the DOC-05 retention review under
// /reports, and the SMS opt-out note on the lease page. `effectLabels` needs
// no test here: lease-holds.spec.ts already asserts the sentence it renders,
// and the change there was calling the function instead of inlining its body.
//
// All four readers scope themselves (or read reference data any staff role
// may see), so unlike ops-visibility.spec.ts there is no portfolio-only
// branch to prove.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const ruleIds: string[] = []
const documentIds: string[] = []
const tenantIds: string[] = []
const optOutPhones: string[] = []

async function createOwner() {
  const email = `reader-screens-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Reader Screens Test',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id },
  })
  return staff
}

async function seedProperty() {
  const entity = await prisma.legalEntity.create({
    data: { name: `Reader LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Reader House-${randomUUID().slice(0, 8)}`,
      addressLine1: '7 Reader Rd',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  return property
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  await prisma.smsOptOut.deleteMany({ where: { phone: { in: optOutPhones } } })
  await prisma.document.deleteMany({ where: { id: { in: documentIds } } })
  await prisma.jurisdictionRule.deleteMany({ where: { id: { in: ruleIds } } })
  await prisma.accessCode.deleteMany({
    where: { unit: { propertyId: { in: propertyIds } } },
  })
  await prisma.leaseTenant.deleteMany({
    where: { lease: { propertyId: { in: propertyIds } } },
  })
  await prisma.lease.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  await prisma.unit.deleteMany({ where: { propertyId: { in: propertyIds } } })
  // Viewing writes no audit rows, so unlike ops-visibility.spec.ts the staff
  // and properties here are cleanly deletable - but sign-in DOES audit, so
  // keep the deactivate fallback for the actors.
  const auditedStaff = new Set(
    (
      await prisma.auditLog.findMany({
        where: { actorStaffId: { in: staffIds } },
        select: { actorStaffId: true },
      })
    ).map((row) => row.actorStaffId!),
  )
  await prisma.staffAssignment.deleteMany({
    where: { staffUserId: { in: staffIds } },
  })
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
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } })
  await prisma.legalEntity.deleteMany({ where: { id: { in: entityIds } } })
})

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test('the jurisdiction page shows every version, not just the current one', async ({
  page,
}) => {
  const state = uniqueStateCode()
  const superseded = await prisma.jurisdictionRule.create({
    data: {
      state,
      version: 1,
      effectiveFrom: new Date('2020-01-01'),
      effectiveTo: new Date('2023-01-01'),
      graceDays: 3,
      lateFeeType: 'NONE',
      paymentAllocationOrder: [],
    },
  })
  const current = await prisma.jurisdictionRule.create({
    data: {
      state,
      version: 2,
      effectiveFrom: new Date('2023-01-01'),
      graceDays: 5,
      lateFeeType: 'NONE',
      paymentAllocationOrder: [],
    },
  })
  ruleIds.push(superseded.id, current.id)

  const staff = await createOwner()
  await signIn(page, staff.email)
  await page.goto('/jurisdiction')

  const row = page
    .getByRole('listitem')
    .filter({ hasText: `${state} — Statewide` })
  await row.getByText('Version history (2)').click()
  await expect(row.getByText(/v1 · effective .* to .*/)).toBeVisible()
  await expect(row.getByText(/v2 · effective .* — current/)).toBeVisible()
})

test('a code slot on the unit page shows its version history without the codes', async ({
  page,
}) => {
  const property = await seedProperty()
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${randomUUID().slice(0, 6)}`, status: 'VACANT' },
  })
  const oldLabel = `Old lockbox ${randomUUID().slice(0, 6)}`
  const secret = `SECRET-${randomUUID().slice(0, 8)}`
  await prisma.accessCode.create({
    data: {
      unitId: unit.id,
      type: 'LOCKBOX',
      label: oldLabel,
      sealedCode: secret,
      version: 1,
      effectiveFrom: new Date('2025-01-01'),
      effectiveTo: new Date('2025-06-01'),
    },
  })
  await prisma.accessCode.create({
    data: {
      unitId: unit.id,
      type: 'LOCKBOX',
      sealedCode: `SEALED-${randomUUID().slice(0, 8)}`,
      version: 2,
      effectiveFrom: new Date('2025-06-01'),
    },
  })

  const staff = await createOwner()
  await signIn(page, staff.email)
  await page.goto(`/properties/${property.id}/units/${unit.id}`)

  await page.getByText('History (2 versions)').click()
  await expect(page.getByText(`v1 — ${oldLabel}`)).toBeVisible()
  await expect(page.getByText(/v2 · set .* · current/)).toBeVisible()
  // The whole point of "sealed": history must never leak a code value.
  await expect(page.getByText(secret)).toHaveCount(0)
})

test('the retention review lists a document past its window', async ({ page }) => {
  const property = await seedProperty()
  const fileName = `ancient-lease-${randomUUID().slice(0, 8)}.pdf`
  const document = await prisma.document.create({
    data: {
      propertyId: property.id,
      type: 'LEASE',
      fileName,
      contentType: 'application/pdf',
      sizeBytes: 100,
      storageKey: `reader-screens/${randomUUID()}`,
      // LEASE retains 7 years; 2015 is safely past the window.
      createdAt: new Date('2015-03-01'),
    },
  })
  documentIds.push(document.id)

  const staff = await createOwner()
  await signIn(page, staff.email)
  await page.goto('/reports/retention')

  await expect(
    page.getByRole('heading', { name: 'Retention review' }),
  ).toBeVisible()
  await expect(page.getByText(fileName)).toBeVisible()
})

test('the lease page says a tenant has opted out of texts', async ({ page }) => {
  const property = await seedProperty()
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${randomUUID().slice(0, 6)}`, status: 'OCCUPIED' },
  })
  const phone = uniquePhone()
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Opted',
      lastName: `Out-${randomUUID().slice(0, 6)}`,
      email: `opted-${randomUUID().slice(0, 6)}@example.test`,
      phone,
    },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      endsOn: new Date('2026-12-31'),
      rentCents: 150_000,
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id },
  })
  const normalized = normalizePhone(phone)!
  optOutPhones.push(normalized)
  await prisma.smsOptOut.create({
    data: { phone: normalized, source: 'INBOUND_KEYWORD', reason: 'STOP' },
  })

  const staff = await createOwner()
  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)

  await expect(page.getByText('(opted out of texts)')).toBeVisible()
})
