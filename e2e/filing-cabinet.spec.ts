import { axeScan, expectFocusSurvived } from './fixtures.ts'
import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { friendlyBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// The property filing cabinet (PROP-06, R-015): mortgages (ARM-adjustment
// and balloon-maturity alerts), insurance (renewal alert), HOA info, and
// warranties. None of these writes are privileged - unlike R-012's
// document.delete or R-014's accesscode.reveal, 'property.write' is not in
// PRIVILEGED_PERMISSIONS, so every test here signs in plainly.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []

async function createStaff(
  roleKey: string,
  scope?: { propertyId?: string; legalEntityId?: string },
) {
  const email = `filing-cabinet-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Filing Cabinet Test',
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

async function seedProperty(name = 'Seed House') {
  const entity = await prisma.legalEntity.create({
    data: { name: `Seed LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${name}-${randomUUID().slice(0, 8)}`,
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  return { entity, property }
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  await prisma.mortgage.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.insurancePolicy.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.hoaInfo.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.warranty.deleteMany({ where: { propertyId: { in: propertyIds } } })
  // BEFORE the staff cleanup below: `recordedByStaffId` is onDelete Restrict,
  // so an improvement left behind blocks the staff user it names.
  await prisma.capitalImprovement.deleteMany({ where: { propertyId: { in: propertyIds } } })

  const auditedProperties = new Set(
    (
      await prisma.auditLog.findMany({
        where: { propertyId: { in: propertyIds } },
        select: { propertyId: true },
      })
    ).map((row) => row.propertyId!),
  )
  await prisma.property.deleteMany({
    where: { id: { in: propertyIds.filter((id) => !auditedProperties.has(id)) } },
  })
  await prisma.property.updateMany({
    where: { id: { in: [...auditedProperties] } },
    data: { active: false },
  })
  const stillReferenced = new Set(
    (
      await prisma.property.findMany({
        where: { legalEntityId: { in: entityIds } },
        select: { legalEntityId: true },
      })
    ).map((row) => row.legalEntityId),
  )
  await prisma.legalEntity.deleteMany({
    where: { id: { in: entityIds.filter((id) => !stillReferenced.has(id)) } },
  })

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

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.describe('cost basis', () => {
  test('sets and updates the cost basis', async ({ page }) => {
    const { property } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}`)
    // The cost-basis form is visible on first render, not revealed by a
    // <details> click - unlike this suite's other forms, nothing naturally
    // delays interaction past React's hydration attaching the real Server
    // Action handler, so a deliberate wait is needed before the first
    // submit (same race documented in e2e/documents.spec.ts's restore test).
    await page.waitForTimeout(500)
    await page.getByLabel('Cost basis ($)').fill('250000')
    await page.getByRole('button', { name: 'Save' }).click()

    // expect.poll(), not a single read - see e2e/operational.spec.ts's
    // identical comment on cross-connection Neon read lag.
    await expect
      .poll(
        async () =>
          (await prisma.property.findUniqueOrThrow({ where: { id: property.id } })).costBasisCents,
        { timeout: 10_000 },
      )
      .toBe(25_000_000)
  })
})

test.describe('mortgages', () => {
  test('adds a mortgage, then removes it', async ({ page }) => {
    const { property } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}`)
    await page.getByText('Add a mortgage').click()
    await expectFocusSurvived(page, 'opening “Add a mortgage” — the filing-cabinet disclosure')
    await page.getByLabel('Lender').fill('First National')
    await page.getByLabel('Rate type').selectOption('FIXED')
    await page.getByLabel('Current balance ($)').fill('180000')
    await page.getByRole('button', { name: 'Add mortgage' }).click()
    await expect(page.getByText('First National — FIXED')).toBeVisible()

    await page.getByRole('button', { name: 'Remove' }).click()
    await expect(page.getByText('First National — FIXED')).toHaveCount(0)

    const remaining = await prisma.mortgage.count({ where: { propertyId: property.id } })
    expect(remaining).toBe(0)
  })

  test('requires an adjustment date for an ARM', async ({ page }) => {
    const { property } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}`)
    await page.getByText('Add a mortgage').click()
    await page.getByLabel('Lender').fill('Second National')
    await page.getByLabel('Rate type').selectOption('ARM')
    await page.getByRole('button', { name: 'Add mortgage' }).click()
    await expect(page.getByText('Enter the next adjustment date for an ARM.')).toBeVisible()
  })

  test('flags an ARM adjusting soon, but not one adjusting far out', async ({ page }) => {
    const { property } = await seedProperty()
    const soon = new Date()
    soon.setDate(soon.getDate() + 30)
    const farOut = new Date()
    farOut.setDate(farOut.getDate() + 400)

    await prisma.mortgage.createMany({
      data: [
        {
          propertyId: property.id,
          lender: 'Soon Bank',
          rateType: 'ARM',
          armAdjustmentDate: soon,
          isBalloon: false,
        },
        {
          propertyId: property.id,
          lender: 'Later Bank',
          rateType: 'ARM',
          armAdjustmentDate: farOut,
          isBalloon: false,
        },
      ],
    })

    const staff = await createStaff('owner')
    await signIn(page, staff.email)
    await page.goto(`/properties/${property.id}`)

    const soonRow = page.getByRole('listitem').filter({ hasText: 'Soon Bank' })
    await expect(soonRow.getByText('ARM adjusts')).toBeVisible()
    const laterRow = page.getByRole('listitem').filter({ hasText: 'Later Bank' })
    await expect(laterRow.getByText('ARM adjusts')).toHaveCount(0)
  })
})

test.describe('insurance', () => {
  test('adds a policy and flags a near renewal', async ({ page }) => {
    const { property } = await seedProperty()
    const renewsOn = new Date()
    renewsOn.setDate(renewsOn.getDate() + 30)
    // Two forms of the same day, and the difference is the point: the date
    // input takes ISO, the screen prints plain language (R-121).
    const isoRenewsOn = renewsOn.toISOString().slice(0, 10)

    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}`)
    await page.getByText('Add a policy').click()
    await page.getByLabel('Carrier').fill('State Farm')
    await page.getByLabel('Renews on').fill(isoRenewsOn)
    await page.getByRole('button', { name: 'Add policy' }).click()
    await expect(
      page.getByText(`State Farm · renews ${friendlyBusinessDate(isoRenewsOn)}`),
    ).toBeVisible()
    await expect(page.getByText('Renewal shopping window open')).toBeVisible()
  })
})

test.describe('HOA', () => {
  test('sets HOA info, then replaces it', async ({ page }) => {
    const { property } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}`)
    await page.getByText('Add HOA info').click()
    await page.getByLabel('HOA name').fill('Maple Grove HOA')
    await page.getByLabel('Has a rental cap or restriction').check()
    await page.getByLabel('Rental cap policy').fill('Capped at 20% of units.')
    await page.getByRole('button', { name: 'Save HOA info' }).click()
    await expect(page.getByText('Maple Grove HOA · rental cap in effect')).toBeVisible()

    const rows = await prisma.hoaInfo.findMany({ where: { propertyId: property.id } })
    expect(rows).toHaveLength(1)

    await page.getByText('Edit HOA info').click()
    if (!(await page.getByLabel('HOA name').isVisible())) {
      await page.getByText('Edit HOA info').click()
    }
    await page.getByLabel('HOA name').fill('Maple Grove HOA (renamed)')
    await page.getByRole('button', { name: 'Update HOA info' }).click()
    await expect(page.getByText('Maple Grove HOA (renamed) · rental cap in effect')).toBeVisible()

    const rowsAfter = await prisma.hoaInfo.findMany({ where: { propertyId: property.id } })
    expect(rowsAfter).toHaveLength(1)
  })
})

test.describe('warranties', () => {
  test('adds a warranty and removes it', async ({ page }) => {
    const { property } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}`)
    await page.getByText('Add a warranty').click()
    await page.getByLabel('Category').selectOption('ROOF')
    await page.getByLabel('Provider').fill('GAF')
    await page.getByRole('button', { name: 'Add warranty' }).click()
    await expect(page.getByText('Roof — GAF')).toBeVisible()

    await page.getByRole('button', { name: 'Remove' }).click()
    await expect(page.getByText('Roof — GAF')).toHaveCount(0)
  })
})

test.describe('scoping (ROLE-01)', () => {
  test('a property-scoped manager without property.write on this property sees no write controls', async ({
    page,
  }) => {
    const { property: mine } = await seedProperty('Mine')
    const { property: theirs } = await seedProperty('Theirs')
    const staff = await createStaff('manager', { propertyId: mine.id })
    await signIn(page, staff.email)

    await page.goto(`/properties/${theirs.id}`)
    await expect(page.getByText('Add a mortgage')).toHaveCount(0)
    await expect(page.getByLabel('Cost basis ($)')).toHaveCount(0)
  })
})

test.describe('accessibility', () => {
  test('the property detail page with a filing cabinet has no detectable violations', async ({
    page,
  }) => {
    const { property } = await seedProperty()
    await prisma.mortgage.create({
      data: { propertyId: property.id, lender: 'First National', rateType: 'FIXED', isBalloon: false },
    })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}`)
    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})

test.describe('capital improvements (PROP-07)', () => {
  test('records one, and flags it when no in-service date was given', async ({ page }) => {
    const { property } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}`)
    await page.getByText('Add an improvement').click()
    await page.getByLabel('Component').selectOption('ROOF')
    await page.getByLabel('What was done').fill('Full tear-off, architectural shingle')
    await page.getByLabel('Project cost').fill('14500')
    await page.getByLabel('Placed in service on').fill('2026-05-02')
    await page.getByRole('button', { name: 'Add improvement' }).click()

    await expect(page.getByText('Roof — Full tear-off, architectural shingle')).toBeVisible()
    await expect(page.getByText('In service 2 May 2026')).toBeVisible()

    // The second one has no date, so the export could not depreciate it -
    // said on the record itself rather than only in the export, because this
    // is the screen where somebody can fix it.
    await page.getByText('Add an improvement').click()
    await page.getByLabel('Component').selectOption('HVAC')
    await page.getByLabel('What was done').fill('Condenser and coil')
    await page.getByLabel('Project cost').fill('6200')
    await page.getByRole('button', { name: 'Add improvement' }).click()

    await expect(
      page.getByText('No in-service date — cannot be depreciated'),
    ).toBeVisible()
  })

  test('refuses an improvement with no cost', async ({ page }) => {
    const { property } = await seedProperty()
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${property.id}`)
    await page.getByText('Add an improvement').click()
    await page.getByLabel('Component').selectOption('ROOF')
    await page.getByLabel('What was done').fill('Roof')
    // Zero, not blank: a blank `required` number field is refused by the
    // BROWSER, so the server-side guard this test exists for never runs.
    await page.getByLabel('Project cost').fill('0')
    await page.getByRole('button', { name: 'Add improvement' }).click()

    await expect(page.getByText('Enter what the improvement cost.')).toBeVisible()
  })

  test("refuses a work order that belongs to another property", async ({ page }) => {
    const { property: mine } = await seedProperty('Mine')
    const { property: theirs } = await seedProperty('Theirs')
    const unit = await prisma.unit.create({
      data: { propertyId: theirs.id, name: `U-${randomUUID().slice(0, 6)}`, status: 'VACANT' },
    })
    const job = await prisma.workOrder.create({
      data: { propertyId: theirs.id, unitId: unit.id, scope: 'Someone else’s roof' },
    })
    const staff = await createStaff('owner')
    await signIn(page, staff.email)

    await page.goto(`/properties/${mine.id}`)
    await page.getByText('Add an improvement').click()
    await page.getByLabel('Component').selectOption('ROOF')
    await page.getByLabel('What was done').fill('Roof')
    await page.getByLabel('Project cost').fill('14500')
    await page.getByLabel('Work order ID').fill(job.id)
    await page.getByRole('button', { name: 'Add improvement' }).click()

    await expect(page.getByText('No work order on this property has that ID.')).toBeVisible()

    await prisma.workOrder.delete({ where: { id: job.id } })
    await prisma.unit.delete({ where: { id: unit.id } })
  })
})
