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
  // `exact`, because R-116 put the deduction's description into the Remove
  // button's accessible name so one row's control can be told from another's
  // - and `sr-only` text is still text in the DOM, so a substring match now
  // finds two (R-115 learned this the same way).
  await expect(page.getByText('Missing blinds', { exact: true })).toBeVisible()
  await expect(page.getByText(/Unsupported/)).toBeVisible()

  // A deduction old enough to trigger the depreciation warning.
  await page.getByLabel('Description').fill('Carpet replacement')
  await page.getByLabel('Amount ($)').fill('900')
  await page.getByLabel('Estimated age (years, optional)').fill('9')
  await page.getByLabel('Useful life (years, optional)').fill('7')
  await page.getByRole('button', { name: 'Add deduction' }).click()
  await expect(page.getByText('Carpet replacement', { exact: true })).toBeVisible()
  await expect(page.getByText(/Age-based guidance suggests/)).toBeVisible()

  // Totals: $2000 held, $960 deducted, $1040 refund due.
  const totals = page.locator('#totals').locator('..')
  await expect(totals).toContainText('$960.00')
  await expect(totals).toContainText('$1,040.00')

  const a11y = await axeScan(page)
  expect(a11y.violations).toEqual([])

  // R-116: the press that mints the letter is gated on an acknowledgement,
  // because the sentence right above it says it cannot be undone.
  await page.getByRole('button', { name: 'Finalize disposition' }).click()
  // The browser refuses the submit outright and focuses the box - so the
  // press costs nothing and nothing was written. (Asserting the URL here
  // would assert something that was already true before the click.)
  const acknowledge = page.getByLabel('I understand the letter is sent and cannot be undone')
  await expect(acknowledge).toBeFocused()
  await acknowledge.check()
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

  // ==========================================================================
  // R-170: THE LETTER IS NOT THE PAYMENT.
  //
  // Everything above used to be the whole flow, and it left $1,040 promised
  // in writing with no way to pay it and every report reading the deposit as
  // settled. From here: the obligation exists as a Task, the deposit screen
  // is still reachable to discharge it, and only the disbursement releases
  // the liability.
  // ==========================================================================
  expect(deposit.refundPaidOn).toBeNull()

  const refundTask = await prisma.task.findFirstOrThrow({
    where: { type: 'deposit_refund_due', subjectId: deposit.id },
  })
  expect(refundTask.subjectType).toBe('Deposit')
  expect(refundTask.status).toBe('OPEN')
  expect(refundTask.priority).toBe('URGENT')
  expect(refundTask.title).toContain('$1,040.00')

  // The task is not a dead end - it reaches the screen that can discharge it.
  await page.goto(`/tasks/${refundTask.id}`)
  await page.getByRole('link', { name: 'Open the deposit disposition to record the refund' }).click()
  await page.waitForURL(`**/leases/${lease.id}/deposit`)

  // The deduction list is locked: it renders, its controls do not.
  await expect(page.getByText('Missing blinds', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Remove/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add deduction' })).toHaveCount(0)

  await expect(page.getByRole('heading', { name: 'Refund payment' })).toBeVisible()
  const refundA11y = await axeScan(page)
  expect(refundA11y.violations).toEqual([])

  // A check with no number is refused - a refund nobody can match back to a
  // bank statement is the tenant's word against the owner's.
  await page.getByLabel('Date the refund was paid').fill('2026-08-28')
  await page.getByRole('button', { name: 'Record refund payment' }).click()
  await expect(page.getByText('Enter the check number, trace or confirmation number.')).toBeVisible()
  expect((await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } })).refundPaidOn).toBeNull()

  await page.getByLabel('How the refund was paid').selectOption('OFFLINE_CHECK')
  await page.getByLabel('Date the refund was paid').fill('2026-08-28')
  await page.getByLabel('Check, trace or confirmation number').fill('10425')
  await page.getByRole('button', { name: 'Record refund payment' }).click()

  // Poll the FACT the next assertions rest on, not a UI signal that was
  // already true before the press (CLAUDE.md's own rule - the "Refund
  // payment" heading is on the page in both states).
  await expect
    .poll(async () =>
      (await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } })).refundPaidOn,
    )
    .not.toBeNull()

  const paid = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } })
  // A calendar day, stored as one - no zone may touch it (D-3).
  expect(paid.refundPaidOn?.toISOString()).toBe('2026-08-28T00:00:00.000Z')
  expect(paid.refundMethod).toBe('OFFLINE_CHECK')
  expect(paid.refundReference).toBe('10425')
  expect(paid.refundRecordedById).not.toBeNull()

  // The obligation is closed by the disbursement, not by a second click.
  const closedTask = await prisma.task.findUniqueOrThrow({ where: { id: refundTask.id } })
  expect(closedTask.status).toBe('DONE')
  expect((closedTask.proof as { note?: string }).note).toContain('28 Aug 2026')

  const refundAudit = await prisma.auditLog.findFirst({
    where: { action: 'deposit.refund_recorded', entityId: deposit.id },
  })
  expect(refundAudit).not.toBeNull()

  // And the record survives on the screen, which is what a former tenant
  // claiming the money never came back is answered with.
  await expect(page.getByText('10425')).toBeVisible()
  await expect(page.getByText('28 Aug 2026')).toBeVisible()

  // Write-once: a second attempt is refused, not silently applied again.
  await expect(page.getByRole('button', { name: 'Record refund payment' })).toHaveCount(0)
})
