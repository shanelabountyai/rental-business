import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// Assistance-animal requests through the browser (RISK-13, R-086).
//
// ==========================================================================
// WHAT ONLY A BROWSER PROVES: THAT APPROVING ONE ACTUALLY STOPS THE MONEY.
//
// The fair-housing rules are pure and unit-tested in
// packages/core/accommodations; the fact the charge writer reads is proved
// against a database in lib/accommodations/accommodations.test.ts. What
// neither can show is the join between them — that a PM who approves an
// assistance animal and then goes to add pet rent is refused, on the screen,
// by the product rather than by a policy document.
//
// The second load-bearing assertion is the documentation gate: a
// service-animal request must offer no way to demand a letter, because
// asking is itself the violation.
// ==========================================================================

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []

async function seedTenancy() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Accom LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Accom House-${stamp}`,
      addressLine1: '4 Accommodation Way',
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
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Robin', lastName: `Accom-${stamp}` },
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
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({
    data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true },
  })
  return { property, lease, tenant }
}

/// Portfolio-wide owner. No MFA: nothing on this path is a privileged
/// permission — see the actions' own header for why `lease.write` is the
/// right bar for deciding an accommodation request.
async function seedOwner() {
  const staff = await prisma.staffUser.create({
    data: {
      email: `accom-${randomUUID()}@example.test`,
      name: 'Accommodation Owner',
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
  // AccommodationRequest points at StaffUser and Tenant with Restrict, and
  // every action here writes an append-only audit row — nothing is deleted.
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.lease.updateMany({ where: { id: { in: leaseIds } }, data: { status: 'ENDED' } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.$disconnect()
})

test('THE POINT: approving an assistance animal refuses pet rent on the tenancy', async ({
  page,
}) => {
  const { lease, tenant } = await seedTenancy()
  const staff = await seedOwner()

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)

  // Pet rent is ordinary and allowed before anything is approved — asserted
  // first, so a later refusal cannot be the panel simply being broken.
  await page.getByText('Add a monthly charge').click()
  await page.getByLabel('What is it?').selectOption('PET_RENT')
  await page.getByLabel('What was agreed?').fill('Dog')
  await page.getByLabel('How much a month?').fill('35')
  await page.getByRole('button', { name: 'Add this charge' }).click()
  await expect
    .poll(() => prisma.recurringCharge.count({ where: { leaseId: lease.id, type: 'PET_RENT' } }))
    .toBe(1)

  // Now an assistance animal is approved.
  await prisma.accommodationRequest.create({
    data: {
      propertyId: lease.propertyId,
      leaseId: lease.id,
      tenantId: tenant.id,
      kind: 'ASSISTANCE_ANIMAL',
      status: 'APPROVED',
      requestText: 'Asked to keep an emotional-support dog.',
      receivedOn: new Date('2026-08-01T00:00:00.000Z'),
      decidedOn: new Date('2026-08-05T00:00:00.000Z'),
      decidedByStaffId: staff.id,
      determinationText: 'Approved as an assistance animal under the FHA; no pet charges apply.',
      subjectDescription: 'Bella, a labrador retriever',
    },
  })

  await page.reload()
  await page.getByText('Add a monthly charge').click()
  await page.getByLabel('What is it?').selectOption('PET_RENT')
  await page.getByLabel('What was agreed?').fill('Second dog')
  await page.getByLabel('How much a month?').fill('35')
  await page.getByRole('button', { name: 'Add this charge' }).click()

  await expect(page.getByText(/not a pet — no pet rent/i)).toBeVisible()
  // Still one. The refusal is the product's, not a screen's.
  expect(
    await prisma.recurringCharge.count({ where: { leaseId: lease.id, type: 'PET_RENT' } }),
  ).toBe(1)
})

test('a service-animal request offers no way to demand documentation', async ({ page }) => {
  const { lease, tenant } = await seedTenancy()
  const staff = await seedOwner()
  await prisma.accommodationRequest.create({
    data: {
      propertyId: lease.propertyId,
      leaseId: lease.id,
      tenantId: tenant.id,
      kind: 'SERVICE_ANIMAL',
      status: 'RECEIVED',
      requestText: 'Presented a dog trained to alert to seizures.',
      receivedOn: new Date('2026-08-01T00:00:00.000Z'),
    },
  })

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)

  // The reason is on the screen, and the control is not there at all —
  // asking is itself the violation, so there is nothing to press.
  await expect(page.getByText(/may not require documentation/i)).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Record that documentation was requested' }),
  ).toHaveCount(0)
})

test('the clock is shown, and an old request reads as overdue', async ({ page }) => {
  const { lease, tenant } = await seedTenancy()
  const staff = await seedOwner()
  // Received sixty days ago, undecided. Relative to now rather than a fixed
  // date: the clock is measured against today, so a hard-coded date would
  // quietly stop testing overdue-ness once it aged.
  const receivedOn = new Date(Date.now() - 60 * 86_400_000)
  await prisma.accommodationRequest.create({
    data: {
      propertyId: lease.propertyId,
      leaseId: lease.id,
      tenantId: tenant.id,
      kind: 'ASSISTANCE_ANIMAL',
      status: 'RECEIVED',
      requestText: 'Asked to keep an emotional-support cat.',
      receivedOn: new Date(receivedOn.toISOString().slice(0, 10) + 'T00:00:00.000Z'),
    },
  })

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)

  // Matched on the clock's own wording, which nothing else on the page
  // says. The count is computed, so the regex must not pin the number.
  await expect(page.getByText(/Outstanding \d+ days — past the 10-day mark/)).toBeVisible()
})

test('a determination is written, notified, and refuses to be vague', async ({ page }) => {
  const { lease, tenant } = await seedTenancy()
  const staff = await seedOwner()
  const request = await prisma.accommodationRequest.create({
    data: {
      propertyId: lease.propertyId,
      leaseId: lease.id,
      tenantId: tenant.id,
      kind: 'ASSISTANCE_ANIMAL',
      status: 'RECEIVED',
      requestText: 'Asked to keep an emotional-support dog in the home.',
      receivedOn: new Date('2026-08-01T00:00:00.000Z'),
    },
  })

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)

  await page.getByLabel('Approve or deny').selectOption('DENIED')
  await page.getByLabel('The written determination').fill('no')
  await page.getByRole('button', { name: 'Record the determination' }).click()

  // Refused, and the message says why a bare denial is the dangerous one.
  await expect(page.getByText(/indistinguishable from a discriminatory one/i)).toBeVisible()
  // THE WRITTEN TEXT SURVIVES THE REFUSAL, which is the part that matters —
  // somebody who wrote three paragraphs and got a validation error does not
  // lose them. The outcome select does NOT survive, and cannot with an
  // uncontrolled `<select>`: React applies a select's `defaultValue` only at
  // mount, so the echoed value repopulates a text field and silently does
  // nothing here. It is visibly empty and `required`, so the retry is
  // obvious rather than silent. See this item's PROGRESS entry.
  await expect(page.getByLabel('The written determination')).toHaveValue('no')
  expect(
    (await prisma.accommodationRequest.findUniqueOrThrow({ where: { id: request.id } })).status,
  ).toBe('RECEIVED')

  // Re-picked, because the select is empty — which is what a person sees and
  // does too.
  await page.getByLabel('Approve or deny').selectOption('DENIED')
  await page
    .getByLabel('The written determination')
    .fill(
      'Denied: reliable documentation of a disability-related need was lawfully requested on 6 August and not provided by 20 August.',
    )
  await page.getByRole('button', { name: 'Record the determination' }).click()

  await expect
    .poll(() =>
      prisma.accommodationRequest
        .findUniqueOrThrow({ where: { id: request.id } })
        .then((row) => row.status),
    )
    .toBe('DENIED')

  const decided = await prisma.accommodationRequest.findUniqueOrThrow({
    where: { id: request.id },
  })
  expect(decided.decidedByStaffId).toBe(staff.id)
  expect(decided.decidedOn).not.toBeNull()
  expect(decided.determinationText).toContain('lawfully requested')

  // The requester is told, through the engine (R-030) — never by hand.
  await expect
    .poll(() =>
      prisma.notificationDelivery.count({
        where: { notification: { recipientId: tenant.id, recipientType: 'TENANT' } },
      }),
    )
    .toBeGreaterThan(0)
})
