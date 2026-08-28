import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// Lease-violation case files through the browser (RISK-02, RISK-03; R-088).
//
// ==========================================================================
// WHAT ONLY A BROWSER PROVES.
//
// The rules are pure and unit-tested in packages/core/violations. Three
// things live only in the join between them and the screens, and all three
// are the ones that go wrong quietly:
//
//   1. A PREMISES_CONDITION case makes you name an enforceable ground before
//      it will take an observation, and the ground picker offers nothing that
//      names the tenant. That is the whole of "target the lease term, never
//      the person" — and it is a UI fact, because the enum only helps if the
//      form actually uses it.
//   2. Legitimizing an unauthorized occupant is refused against an applicant
//      with no screening decision. The temptation this exists to block is a
//      manager waving through the person already living there, which is
//      disparate treatment recorded in your own system.
//   3. An unauthorized-animal case will not close as "authorized pet" while
//      an accommodation request on the same tenancy is undecided.
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
    data: { name: `Viol LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Viol House-${stamp}`,
      addressLine1: '9 Violation Row',
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
    data: { firstName: 'Sam', lastName: `Viol-${stamp}` },
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
  return { property, unit, lease, tenant, stamp }
}

async function seedOwner() {
  const staff = await prisma.staffUser.create({
    data: {
      email: `viol-${randomUUID()}@example.test`,
      name: 'Violation Owner',
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
  // ViolationCase points at StaffUser, Property, Unit, Lease and Applicant
  // with Restrict, and every action writes an append-only audit row — nothing
  // here is deleted, everything is retired.
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.lease.updateMany({ where: { id: { in: leaseIds } }, data: { status: 'ENDED' } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.$disconnect()
})

test('THE POINT: a condition case is enforced on a lease term, and the vocabulary has no word for the tenant', async ({
  page,
}) => {
  const { lease } = await seedTenancy()
  const staff = await seedOwner()

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)

  await page.getByText('Open a violation case').click()
  await page.getByLabel('What is being alleged?').selectOption('PREMISES_CONDITION')

  // The ground picker is the guardrail. Every option is something a notice
  // could cite; none of them describes a person. A later session adding
  // "Hoarding" or "Poor housekeeping" to the enum fails here.
  const grounds = page.getByLabel('Which lease or safety term')
  const options = await grounds.locator('option').allTextContents()
  const offered = options.join(' ').toLowerCase()
  for (const word of ['hoard', 'clutter', 'housekeep', 'filth', 'squalor', 'tenant']) {
    expect(offered).not.toContain(word)
  }

  await grounds.selectOption('BLOCKED_EGRESS')
  await page.getByLabel('Date it was seen').fill('2026-08-20')
  await page
    .getByLabel('What was seen, and where')
    .fill('Rear bedroom window blocked to the sill by stacked boxes; the sash cannot open.')
  await page.getByRole('button', { name: 'Open the violation case' }).click()

  await page.waitForURL(/\/violations\/[a-z0-9]+$/)
  // By ROLE, not by text: this string is the page's <h1>, so Next's own
  // #__next-route-announcer__ carries a copy of it after the redirect and a
  // text match resolves to two elements. Went red on the 16.2.12 -> 16.3.3
  // bump, which is when that announcer started holding the heading.
  await expect(
    page.getByRole('heading', {
      name: 'The state of the premises breaches a lease or safety term',
    }),
  ).toBeVisible()
  // Dated, so the locator cannot also match the identical string sitting in
  // the ground picker of the "record another visit" form below it — the
  // substring-collision trap in CLAUDE.md, arriving inside a spec rather than
  // between two panels.
  await expect(
    page.getByText('20 Aug 2026 · A required exit, window or corridor is obstructed'),
  ).toBeVisible()

  // No notice served, so no cure clock is running — and the page says so
  // rather than showing a deadline it invented.
  await expect(page.getByText('no cure period is running')).toBeVisible()

  // A condition is never "legitimized": there is no version of a blocked fire
  // exit that becomes permitted by agreement, so the outcome is not offered.
  const outcomes = await page.getByLabel('How did this end?').locator('option').allTextContents()
  expect(outcomes.join(' ')).not.toContain('Legitimized')
})

test('legitimizing an occupant is refused against an application with no screening decision', async ({
  page,
}) => {
  const { property, lease, stamp } = await seedTenancy()
  const staff = await seedOwner()

  // An applicant who exists but has never been screened. This is the exact
  // shape of the shortcut the rule exists to block: the person is already
  // living there, the paperwork feels like theatre, and waving them through
  // is disparate treatment with a name and a date on it.
  const listing = await prisma.listing.create({
    data: {
      propertyId: property.id,
      unitId: (await prisma.unit.findFirstOrThrow({ where: { propertyId: property.id } })).id,
      status: 'DRAFT',
      rentCents: 150_000,
      availableOn: new Date('2026-01-01'),
    },
  })
  const prospect = await prisma.prospect.create({
    data: {
      propertyId: property.id,
      listingId: listing.id,
      firstName: 'Alex',
      lastName: `Occupant-${stamp}`,
      // A CHECK constraint requires one contact route — a prospect nobody can
      // reach is not a lead.
      email: `alex-${stamp}@example.test`,
      source: 'WALK_IN',
    },
  })
  const application = await prisma.application.create({
    data: { propertyId: property.id, listingId: listing.id, prospectId: prospect.id },
  })
  await prisma.applicant.create({
    data: {
      applicationId: application.id,
      isLead: true,
      firstName: 'Alex',
      lastName: `Occupant-${stamp}`,
    },
  })

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)
  await page.getByText('Open a violation case').click()
  await page.getByLabel('What is being alleged?').selectOption('UNAUTHORIZED_OCCUPANT')
  await page.getByLabel('Date it was seen').fill('2026-08-20')
  await page
    .getByLabel('What was seen, and where')
    .fill('A second adult answering the door on three visits, with post addressed to them.')
  await page.getByRole('button', { name: 'Open the violation case' }).click()
  await page.waitForURL(/\/violations\/[a-z0-9]+$/)

  await page.getByLabel('How did this end?').selectOption('LEGITIMIZED')
  await page.getByLabel('The application they went through').selectOption({ index: 1 })
  await page
    .getByLabel('The account of how it ended')
    .fill('They applied and have been added to the tenancy from the first of next month.')
  await page.getByRole('button', { name: 'Close this case' }).click()

  await expect(page.getByText(/no screening decision recorded/i)).toBeVisible()
  // Still open. The refusal is the product's, not a screen's.
  expect(await prisma.violationCase.count({ where: { leaseId: lease.id, status: 'OPEN' } })).toBe(1)
})

test('an animal case will not close as an authorized pet while an accommodation request is undecided', async ({
  page,
}) => {
  const { lease, tenant } = await seedTenancy()
  const staff = await seedOwner()

  await signIn(page, staff.email)
  await page.goto(`/leases/${lease.id}`)
  await page.getByText('Open a violation case').click()
  await page.getByLabel('What is being alleged?').selectOption('UNAUTHORIZED_ANIMAL')

  // The fork is shown before anything is recorded: a tenant is not required
  // to volunteer that an animal is an assistance animal, and a notice served
  // on one is a complaint whether or not anybody had been told.
  await expect(page.getByText(/service or assistance animal/i).first()).toBeVisible()

  await page.getByLabel('Date it was seen').fill('2026-08-20')
  await page
    .getByLabel('What was seen, and where')
    .fill('A dog in the rear garden on two visits; the lease permits no animals.')
  await page.getByRole('button', { name: 'Open the violation case' }).click()
  await page.waitForURL(/\/violations\/[a-z0-9]+$/)

  // Now the tenant asks. Undecided — which is exactly the state in which
  // "this is an authorized pet" must not be recorded, because that answers
  // the request in the direction that costs them money.
  await prisma.accommodationRequest.create({
    data: {
      propertyId: lease.propertyId,
      leaseId: lease.id,
      tenantId: tenant.id,
      kind: 'ASSISTANCE_ANIMAL',
      status: 'RECEIVED',
      requestText: 'Asked to keep an emotional-support dog.',
      receivedOn: new Date('2026-08-21T00:00:00.000Z'),
    },
  })

  await page.reload()
  await page.getByLabel('How did this end?').selectOption('LEGITIMIZED')
  await page.getByLabel('The animal being authorized').fill('One retriever, "Bo"')
  await page
    .getByLabel('The account of how it ended')
    .fill('Agreed as a permitted pet with pet rent from the first of next month.')
  await page.getByRole('button', { name: 'Close this case' }).click()

  await expect(page.getByText(/undecided accommodation request/i).first()).toBeVisible()
  expect(await prisma.violationCase.count({ where: { leaseId: lease.id, status: 'OPEN' } })).toBe(1)
})
