import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'

// Tenant door codes tied to lease state (PROP-03, LEASE-08; R-094b).
//
// That a revoked code stops working AT THE DEVICE is proved in
// apps/web/lib/locks/tenant-codes.test.ts, which can reach the simulator.
// What only a browser proves is the rest: that issuing is privileged and
// shows the code once, that the panel says plainly when there is no lock to
// program, and that ending a tenancy revokes the household's codes without
// anybody remembering to.

const PASSWORD = 'correct-horse-battery-staple'
const entityIds: string[] = []
const propertyIds: string[] = []
const staffIds: string[] = []
const tenantIds: string[] = []

async function createStaff(legalEntityId: string) {
  const unique = randomUUID().slice(0, 8)
  const email = `doorcode-${unique}@example.test`
  const enrolment = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: `Door Owner ${unique}`,
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          mfaSecret: sealSecret(enrolment.secret),
          mfaEnrolledAt: new Date(),
        },
      },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, legalEntityId },
  })
  return { ...staff, secret: enrolment.secret }
}

async function seedTenancy({ withLock }: { withLock: boolean }) {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `DoorCode LLC-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `DoorCode House-${unique}`,
      addressLine1: '3 Deadbolt Drive',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
      yearBuilt: 2015,
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'OCCUPIED' },
  })
  if (withLock) {
    await prisma.smartLock.create({
      data: { unitId: unit.id, externalId: `dev-${unique}`, label: 'Front door keypad' },
    })
  }
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Ada',
      lastName: `Resident-${unique}`,
      email: `ada-${unique}@example.test`,
    },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01T00:00:00Z'),
      rentCents: 150_000,
      // Zero, so R-069's move-in-funds gate is satisfied without a deposit
      // fixture - that gate has its own coverage and is not what this spec
      // is about.
      depositCents: 0,
      activatedAt: new Date('2026-01-01T12:00:00Z'),
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  return { entity, property, unit, lease, tenant, unique }
}

async function signIn(
  page: import('@playwright/test').Page,
  staff: { email: string; secret: string },
) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/login\/mfa/)
  await page
    .getByLabel(/code/i)
    .fill(new TOTP({ secret: Secret.fromBase32(staff.secret) }).generate())
  await page.getByRole('button', { name: 'Verify' }).click()
  await page.waitForURL('**/dashboard')
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('a door code is given once, and the tenancy ending takes it back', async ({ page }) => {
  const seed = await seedTenancy({ withLock: true })
  const staff = await createStaff(seed.entity.id)

  await signIn(page, staff)
  await page.goto(`/leases/${seed.lease.id}`)

  const panel = page.getByRole('region', { name: 'Door codes' })
  await expect(panel.getByText('stop working on their own')).toBeVisible()
  await panel.getByRole('button', { name: 'Give them a door code' }).click()

  // Shown once, in this component's own local state - the action deliberately
  // does not revalidate, or the form would be unmounted by its own response
  // before anybody read the code (R-069 documents the same trap).
  await expect(panel.getByText(/door code$/)).toBeVisible()
  await expect(panel.getByText('Shown once')).toBeVisible()

  const code = await prisma.tenantLockCode.findFirstOrThrow({
    where: { leaseId: seed.lease.id },
  })
  expect(code.tenantId).toBe(seed.tenant.id)
  expect(code.issuedByStaffId).toBe(staff.id)
  expect(code.revokedAt).toBeNull()
  // The audit says the DOOR was programmed, which is what distinguishes this
  // from R-069's handover of a code that already existed. Never the code.
  const issued = await prisma.auditLog.findFirstOrThrow({
    where: { entityId: seed.lease.id, action: 'accesscode.issued' },
  })
  expect(issued.after).toMatchObject({ programmedAtDevice: true, tenantId: seed.tenant.id })

  // End the tenancy. Nobody touches the door code, and that is the point.
  await page.goto(`/leases/${seed.lease.id}`)
  await page.getByRole('button', { name: 'Record that the tenancy ended' }).click()

  await expect
    .poll(async () =>
      (await prisma.tenantLockCode.findUniqueOrThrow({ where: { id: code.id } })).revokedAt,
    )
    .not.toBeNull()
  const after = await prisma.tenantLockCode.findUniqueOrThrow({ where: { id: code.id } })
  expect(after.revokedReason).toBe('The tenancy ended.')
  // Automatic, so nobody to attribute it to.
  expect(after.revokedByStaffId).toBeNull()
  expect(after.revokeReachedDevice).toBe(true)
})

test('a unit with no smart lock says so instead of hiding the panel', async ({ page }) => {
  const seed = await seedTenancy({ withLock: false })
  const staff = await createStaff(seed.entity.id)

  await signIn(page, staff)
  await page.goto(`/leases/${seed.lease.id}`)

  const panel = page.getByRole('region', { name: 'Door codes' })
  // An operator who cannot see why the feature is missing assumes it is
  // broken - and the sentence also states the thing R-091 had to state
  // twice: handing over a code changes no lock.
  await expect(panel.getByText('no smart lock on file')).toBeVisible()
  await expect(panel.getByText('changes no lock')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Give them a door code' })).toHaveCount(0)
})
