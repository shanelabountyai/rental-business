import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import {
  createTotpEnrolment,
  hashPassword,
  mintRecoveryCodes,
  sealSecret,
} from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'

// Keys and codes at move-in (INSP-01, R-069): a code stays withheld until
// move-in funds clear, and every release is logged against the lease.
// `packages/core/payments/clearing.test.ts` and
// `apps/web/lib/leases/deposit-clearing-job.test.ts` already prove the
// arithmetic and the job against a real database; what only a browser
// proves is that the gate actually blocks the button and that issuing a
// code, once it clears, shows the tenant's code and sticks.

const PASSWORD = 'correct-horse-battery-staple'
const DEPOSIT_CENTS = 200_000

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []

async function seedProperty() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Keys LLC-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Keys House-${unique}`,
      addressLine1: '9 Move-In Way',
      city: 'Houston',
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
  return { entity, property, unit }
}

async function seedLease(propertyId: string, unitId: string) {
  const unique = randomUUID().slice(0, 8)
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Pat', lastName: `MoveIn-${unique}`, email: `pat-${unique}@example.test` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ACTIVE',
      startsOn: new Date('2026-08-01'),
      rentCents: 150_000,
      depositCents: DEPOSIT_CENTS,
      depositArrangement: 'CASH',
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true } })
  return lease
}

async function createMfaVerifiedOwner(page: import('@playwright/test').Page) {
  const email = `keys-owner-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Keys Test Owner',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })

  const { secret } = createTotpEnrolment(email)
  const recovery = mintRecoveryCodes(3)
  await prisma.staffCredential.update({
    where: { staffUserId: staff.id },
    data: { mfaSecret: sealSecret(secret), mfaEnrolledAt: new Date(), mfaRecoveryCodes: recovery.hashes },
  })

  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/login\/mfa/)
  const code = new TOTP({ secret: Secret.fromBase32(secret) }).generate()
  await page.getByLabel(/code/i).fill(code)
  await page.getByRole('button', { name: 'Verify' }).click()
  await page.waitForURL('**/dashboard')
  return staff
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  // LedgerEntry is append-only and pins Lease/Charge/Payment through it
  // (CLAUDE.md); the property and legal entity are deactivated whole rather
  // than any of that being deleted, the same posture leases.spec.ts's own
  // afterAll already takes for its ledger-touched leases.
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
})

test('a code stays withheld until move-in funds clear, then can be issued and stays logged', async ({
  page,
}) => {
  const { property, unit } = await seedProperty()
  const lease = await seedLease(property.id, unit.id)
  const accessCode = await prisma.accessCode.create({
    data: {
      unitId: unit.id,
      type: 'LOCKBOX',
      label: 'Front door',
      sealedCode: sealSecret('7392', 'access-code'),
      version: 1,
    },
  })

  await createMfaVerifiedOwner(page)
  await page.goto(`/leases/${lease.id}`)

  await expect(page.getByText('Move-in funds have not cleared yet')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Issue to tenant' })).toHaveCount(0)
  await expect(page.getByText('Not yet issued')).toBeVisible()

  const a11y = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(a11y.violations).toEqual([])

  // Move-in funds clear (deposit-clearing-job.test.ts proves this job's own
  // arithmetic against a real database - this seeds the OUTCOME the job
  // would produce, so the e2e stays about the gate and the action, not a
  // second copy of the job's own test).
  await prisma.deposit.create({
    data: {
      propertyId: property.id,
      leaseId: lease.id,
      heldCents: DEPOSIT_CENTS,
      receivedAt: new Date(),
    },
  })

  await page.goto(`/leases/${lease.id}`)
  await expect(page.getByText('Move-in funds have not cleared yet')).toHaveCount(0)
  await page.getByRole('button', { name: 'Issue to tenant' }).click()
  await expect(page.getByText('7392')).toBeVisible()

  const audited = await prisma.auditLog.findFirst({
    where: { entityType: 'Lease', entityId: lease.id, action: 'accesscode.issued' },
  })
  expect(audited?.after).toMatchObject({ accessCodeId: accessCode.id })

  await page.goto(`/leases/${lease.id}`)
  await expect(page.getByRole('button', { name: 'Issue to tenant' })).toHaveCount(0)
  await expect(page.getByText(/Issued \d{4}-\d{2}-\d{2}/)).toBeVisible()
})
