import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// Insurance claims through the browser (RISK-07, R-089).
//
// ==========================================================================
// WHAT ONLY A BROWSER PROVES.
//
// The arithmetic is pure and unit-tested in packages/core/insurance, and the
// Schedule E treatment is tested in packages/core/tax. Three things live only
// in the join between them and the screens:
//
//   1. THE REPAIR COST HAS NO INPUT. It appears on the claim page only after
//      a work order is attached, and it equals that job's own recorded cost.
//      A future session adding a `repairCostCents` box has to break this.
//   2. A claim cannot be opened against no policy — the deductible and the
//      loss-of-rents cover come from the policy, and a claim without one is
//      a claim nobody can evaluate.
//   3. A paid claim will not close with no payment recorded, which is the
//      commonest way a claim file and the P&L come to disagree: the cheque
//      arrived, it was banked, and nobody came back to the screen.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []

async function seedProperty(options: { withPolicy: boolean }) {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Claim LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Claim House-${stamp}`,
      addressLine1: '3 Claim Close',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: {
      propertyId: property.id,
      name: `U-${stamp}`,
      status: 'OCCUPIED',
      marketRentCents: 150_000,
    },
  })
  const policy = options.withPolicy
    ? await prisma.insurancePolicy.create({
        data: {
          propertyId: property.id,
          carrier: `Carrier-${stamp}`,
          policyNumber: `POL-${stamp}`,
          deductibleCents: 250_000,
          lossOfRents: true,
          renewsOn: new Date('2027-01-01T00:00:00.000Z'),
        },
      })
    : null
  return { property, unit, policy, stamp }
}

async function seedOwner() {
  const staff = await prisma.staffUser.create({
    data: {
      email: `claim-${randomUUID()}@example.test`,
      name: 'Claim Owner',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

// Login is rate-limited per IP (R-003).
test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  // InsuranceClaim Restricts against Property, InsurancePolicy, Unit, Lease
  // and StaffUser, and every action writes an append-only audit row - nothing
  // here is deleted, everything is retired.
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.$disconnect()
})

test('THE POINT: the repair cost has no input — it appears only when a job is attached', async ({
  page,
}) => {
  const { property, unit, policy } = await seedProperty({ withPolicy: true })
  const staff = await seedOwner()

  // A job that already cost real money, recorded where D-19 says it belongs.
  const job = await prisma.workOrder.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'CLOSED',
      scope: 'Dry out and replace kitchen subfloor',
      priority: 'URGENT',
      invoiceCents: 800_000,
    },
  })

  await signIn(page, staff.email)
  await page.goto(`/properties/${property.id}`)

  await page.getByText('Open a claim').click()
  await page.getByLabel('Which policy').selectOption(policy!.id)
  await page.getByLabel('What caused the loss').selectOption('WATER')
  await page.getByLabel('When the loss happened').fill('2026-08-20T06:00')
  await page
    .getByLabel('What happened')
    .fill('Supply line to the dishwasher failed overnight; standing water across the kitchen.')
  await page.getByRole('button', { name: 'Open the claim' }).click()

  await page.waitForURL(/\/claims\/[a-z0-9]+$/)

  // Nothing attached yet, so the cost is zero — and the page says why rather
  // than offering a box.
  await expect(page.getByText('None attached, so the repair cost is zero')).toBeVisible()

  await page.getByLabel('Attach a job from this property').selectOption(job.id)
  await page.getByRole('button', { name: 'Attach this job' }).click()

  // $8,000 cost, $2,500 deductible → $5,500 expected recovery, nothing paid.
  await expect(page.getByText('$8,000.00').first()).toBeVisible()
  await expect(page.getByText('$5,500.00').first()).toBeVisible()

  // And there is genuinely no way to type a different figure.
  await expect(page.getByLabel('Repair cost')).toHaveCount(0)
})

test('a claim cannot be opened against a property with no policy on file', async ({ page }) => {
  const { property } = await seedProperty({ withPolicy: false })
  const staff = await seedOwner()

  await signIn(page, staff.email)
  await page.goto(`/properties/${property.id}`)

  await expect(page.getByText('No policy is on file for this property')).toBeVisible()
  // The form is not merely disabled — it is not rendered, so there is nothing
  // to submit against a missing deductible.
  await expect(page.getByRole('button', { name: 'Open the claim' })).toHaveCount(0)
})

test('a paid claim will not close with no payment recorded, and does once one is', async ({
  page,
}) => {
  const { property, policy } = await seedProperty({ withPolicy: true })
  const staff = await seedOwner()

  const claim = await prisma.insuranceClaim.create({
    data: {
      propertyId: property.id,
      policyId: policy!.id,
      cause: 'WIND_HAIL',
      description: 'Hail damage to the roof and two windows on the south elevation.',
      incidentAt: new Date('2026-07-04T18:00:00.000Z'),
      openedByStaffId: staff.id,
    },
  })

  await signIn(page, staff.email)
  await page.goto(`/claims/${claim.id}`)

  await page.getByLabel('The settlement outcome').selectOption('PAID')
  await page
    .getByLabel('What was agreed, and on what basis')
    .fill('Settled at the adjuster’s scope less the deductible; roof replaced in September.')
  await page.getByRole('button', { name: 'Close this claim' }).click()

  await expect(page.getByText(/No payment has been recorded against this claim/i)).toBeVisible()
  expect(
    await prisma.insuranceClaim.count({ where: { id: claim.id, status: 'OPEN' } }),
  ).toBe(1)

  // Record what actually arrived, and the category that decides its tax
  // treatment, then it closes.
  await page.getByLabel('What was this payment for?').selectOption('REPAIR')
  await page.getByLabel('How much arrived?').fill('12500')
  await page.getByLabel('Date it arrived').fill('2026-08-01')
  await page.getByRole('button', { name: 'Record this payment' }).click()
  await expect(page.getByText(/a counted exception for your preparer/i)).toBeVisible()

  await page.getByLabel('The settlement outcome').selectOption('PAID')
  await page
    .getByLabel('What was agreed, and on what basis')
    .fill('Settled at the adjuster’s scope less the deductible; roof replaced in September.')
  await page.getByRole('button', { name: 'Close this claim' }).click()

  await expect
    .poll(async () =>
      prisma.insuranceClaim.count({ where: { id: claim.id, status: 'CLOSED' } }),
    )
    .toBe(1)
})

test('loss of rents is priced off the tenancy’s own rent, and says which rent it used', async ({
  page,
}) => {
  const { property, unit, policy } = await seedProperty({ withPolicy: true })
  const staff = await seedOwner()

  const tenant = await prisma.tenant.create({
    data: { firstName: 'Jo', lastName: `Claim-${randomUUID().slice(0, 6)}` },
  })
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      // Deliberately different from the unit's $1,500 asking rent, so the
      // assertion below can only pass if the LEASE was used.
      rentCents: 180_000,
    },
  })
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })

  const claim = await prisma.insuranceClaim.create({
    data: {
      propertyId: property.id,
      policyId: policy!.id,
      cause: 'FIRE',
      description: 'Kitchen fire; unit uninhabitable while the ceiling was replaced.',
      incidentAt: new Date('2026-06-01T12:00:00.000Z'),
      openedByStaffId: staff.id,
    },
  })

  await signIn(page, staff.email)
  await page.goto(`/claims/${claim.id}`)

  await page.getByLabel('Which unit was out of service').selectOption(unit.id)
  await page.getByLabel('Out of service from').fill('2026-06-01')
  await page.getByLabel('Back in service on').fill('2026-06-30')
  await page.getByRole('button', { name: 'Record the downtime' }).click()

  // 30 days at $1,800/month = $1,800 exactly, on the CONTRACT rent - the
  // unit's $1,500 asking rent would have produced $1,500.
  const panel = page.locator('section[aria-labelledby="loss-of-rents"]')
  await expect(panel.getByText('$1,800.00')).toBeVisible()
  // `.first()` because the sentence carries an inline <strong> for the total,
  // so the paragraph and its text node both match a substring locator. This is
  // nesting, not two controls sharing a name.
  await expect(
    panel.getByText('the rent this tenancy was actually paying').first(),
  ).toBeVisible()

  await prisma.leaseTenant.deleteMany({ where: { leaseId: lease.id } })
  await prisma.lease.update({ where: { id: lease.id }, data: { status: 'ENDED' } })
  await prisma.tenant.update({ where: { id: tenant.id }, data: { active: false } })
})
