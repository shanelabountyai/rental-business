import { randomUUID } from 'node:crypto'
import {
  createTotpEnrolment,
  hashPassword,
  mintRecoveryCodes,
  sealSecret,
} from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { axeScan } from './fixtures.ts'

// Deposit disposition (INSP-03, R-071): itemized deductions, each flagged
// unsupported or not, running totals, and a finalize step that hands off
// to R-051's existing notice machinery for the letter itself. The pure
// arithmetic is proved in packages/core/ledger/disposition.test.ts, the
// countdown/reminder jobs against a real database in
// apps/web/lib/leases/deposit-disposition-{start,reminder-job}.test.ts.
// What only a browser proves is here: a PM building the deduction list,
// seeing the unsupported flag and the depreciation warning, and finalizing
// into a real Notice.

const PASSWORD = 'correct-horse-battery-staple'
const HELD_CENTS = 200_000

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []

async function seedProperty() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Disposition LLC-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Disposition House-${unique}`,
      addressLine1: '21 Trust Ave',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'MAKE_READY' },
  })
  unitIds.push(unit.id)
  return { property, unit }
}

async function seedEndedLeaseWithDeposit(propertyId: string, unitId: string) {
  const unique = randomUUID().slice(0, 8)
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Robin', lastName: `Departed-${unique}`, email: `robin-${unique}@example.test` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      status: 'ENDED',
      startsOn: new Date('2025-06-01'),
      rentCents: 150_000,
      depositCents: HELD_CENTS,
      depositArrangement: 'CASH',
      moveOutAt: new Date('2026-08-15T20:00:00Z'),
      noticeForwardingAddress: '400 Next Place, Anytown, TX 77000',
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true } })
  await prisma.deposit.create({
    data: { propertyId, leaseId: lease.id, heldCents: HELD_CENTS, receivedAt: new Date('2025-06-01') },
  })
  return { lease, tenant }
}

async function createMfaVerifiedOwner(page: import('@playwright/test').Page) {
  const email = `disposition-owner-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Disposition Test Owner',
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
  // Deposit/DepositDeduction/Notice all get real AuditLog entries against
  // the property once this flow runs - deactivated whole, the same posture
  // every other evidence-writing e2e suite in this codebase already takes.
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
})

test('a PM itemizes deductions, sees the unsupported flag and depreciation guidance, and finalizes the disposition', async ({
  page,
}) => {
  const { property, unit } = await seedProperty()
  const { lease } = await seedEndedLeaseWithDeposit(property.id, unit.id)
  await createMfaVerifiedOwner(page)

  await page.goto(`/leases/${lease.id}/deposit`)
  await expect(page.getByText('held $2,000.00')).toBeVisible()

  // An unsupported deduction - no work order, no photo, no file.
  await page.getByLabel('Description').fill('Missing blinds')
  await page.getByLabel('Amount ($)').fill('60')
  await page.getByRole('button', { name: 'Add deduction' }).click()
  await expect(page.getByText('Missing blinds')).toBeVisible()
  await expect(page.getByText(/Unsupported/)).toBeVisible()

  // A deduction old enough to trigger the depreciation warning.
  await page.getByLabel('Description').fill('Carpet replacement')
  await page.getByLabel('Amount ($)').fill('900')
  await page.getByLabel('Estimated age (years, optional)').fill('9')
  await page.getByLabel('Useful life (years, optional)').fill('7')
  await page.getByRole('button', { name: 'Add deduction' }).click()
  await expect(page.getByText('Carpet replacement')).toBeVisible()
  await expect(page.getByText(/Age-based guidance suggests/)).toBeVisible()

  // Totals: $2000 held, $960 deducted, $1040 refund due.
  const totals = page.locator('#totals').locator('..')
  await expect(totals).toContainText('$960.00')
  await expect(totals).toContainText('$1,040.00')

  const a11y = await axeScan(page)
  expect(a11y.violations).toEqual([])

  await page.getByRole('button', { name: 'Finalize disposition' }).click()
  await page.waitForURL(/\/notices\/[a-z0-9]+$/)

  await expect(page.getByRole('heading', { name: 'Deposit disposition' })).toBeVisible()
  await expect(page.getByText(/^Not served yet/)).toBeVisible()

  const notice = await prisma.notice.findFirstOrThrow({ where: { leaseId: lease.id } })
  expect(notice.type).toBe('DEPOSIT_DISPOSITION')
  expect(notice.addressOfRecord).toBe('400 Next Place, Anytown, TX 77000')
  expect(notice.bodyText).toContain('Missing blinds: $60.00')
  expect(notice.bodyText).toContain('Amount being refunded to you: $1,040.00')

  const deposit = await prisma.deposit.findFirstOrThrow({ where: { leaseId: lease.id } })
  expect(deposit.dispositionSentAt).not.toBeNull()
  expect(deposit.appliedCents).toBe(96_000)
  expect(deposit.refundedCents).toBe(104_000)
  expect(deposit.noticeId).toBe(notice.id)

  const finalizedAudit = await prisma.auditLog.findFirst({
    where: { action: 'deposit.disposition_finalized', entityId: deposit.id },
  })
  expect(finalizedAudit).not.toBeNull()
})
