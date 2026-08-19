import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone } from './fixtures.ts'

// Renter's insurance through the browser (LEASE-10, R-067).
//
// The expiry/lapse alert job is proved against directly-seeded rows in
// renter-insurance-job.test.ts. What only a browser proves is here: that a
// PM can actually record a policy on a lease and see it reflected.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `renterins-${unique}@example.test`,
      name: `Renter Insurance Test ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedRunningLease() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({ data: { name: `RI LLC-${unique}`, type: 'LLC' } })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `RI House-${unique}`,
      addressLine1: '4 Insurance Ave',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({ data: { propertyId: property.id, name: `U-${unique}`, status: 'OCCUPIED' } })
  unitIds.push(unit.id)
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Sam', lastName: `Insured-${unique}`, email: `sam-${unique}@example.test`, phone: uniquePhone() },
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
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true } })
  return { property, unit, tenant, lease }
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
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  await prisma.task.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.renterInsurancePolicy.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: leaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.$disconnect()
})

test.describe("renter's insurance", () => {
  test('a PM records a policy with no certificate file, and it shows on the lease', async ({ page }) => {
    const { lease } = await seedRunningLease()
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/leases/${lease.id}`)
    await page.getByRole('heading', { name: "Renter’s insurance" }).scrollIntoViewIfNeeded()
    await page.getByLabel('Carrier').fill('Acme Mutual')
    await page.getByLabel('Policy number').fill('POL-12345')
    await page.getByLabel('Expires on').fill('2027-01-01')
    await page.getByRole('button', { name: 'Record policy' }).click()

    await expect(page.getByText('Acme Mutual · #POL-12345')).toBeVisible()

    const policy = await prisma.renterInsurancePolicy.findFirstOrThrow({ where: { leaseId: lease.id } })
    expect(policy.carrier).toBe('Acme Mutual')
    expect(policy.policyNumber).toBe('POL-12345')
    expect(policy.documentId).toBeNull()

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'lease.renter_insurance_recorded', entityId: lease.id },
    })
    expect(entry).not.toBeNull()
  })
})
