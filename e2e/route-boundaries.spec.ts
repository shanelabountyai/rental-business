import { randomUUID } from 'node:crypto'
import { hashPassword, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone } from './fixtures.ts'

// The screens a person actually lands on when something goes wrong (U1, R-099).
//
// Until R-099 the product had no `error.tsx`, `not-found.tsx` or `loading.tsx`
// anywhere - zero files - while FOURTEEN pages call `notFound()`. So a tenant
// following a stale link out of a six-month-old text message got Next's bare
// 404: black on white, no navigation, no way back, and no hint that their
// account was fine.
//
// Most of the staff `notFound()` calls are not really "no such record" - they
// are ROLE-01 scope refusals, which deliberately answer 404 rather than 403
// because "forbidden" confirms the record exists. The wording is asserted here
// precisely because it has to stay true for BOTH cases without hinting which
// one happened; a well-meaning edit to "this record does not exist" would turn
// the screen into an existence oracle.

const PASSWORD = 'correct-horse-battery-staple-42'

const tenantIds: string[] = []
const staffIds: string[] = []
const propertyIds: string[] = []
const entityIds: string[] = []

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({
    'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
  })
})

test.afterAll(async () => {
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
})

async function seedTenant() {
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Lost',
      lastName: `Link-${randomUUID().slice(0, 6)}`,
      phone: uniquePhone(),
    },
  })
  tenantIds.push(tenant.id)

  const minted = mintToken('TENANT_MAGIC_LINK')
  await prisma.authToken.create({
    data: {
      purpose: 'TENANT_MAGIC_LINK',
      tokenHash: minted.tokenHash,
      subjectType: 'Tenant',
      subjectId: tenant.id,
      expiresAt: minted.expiresAt,
    },
  })
  return { tenant, link: `/portal/verify?token=${minted.token}` }
}

async function seedStaff() {
  const staff = await prisma.staffUser.create({
    data: {
      email: `boundary-${randomUUID().slice(0, 8)}@example.test`,
      name: 'Boundary Staff',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)

  // PROPERTY-SCOPED, AND THAT IS NOT A DETAIL. The first version of this
  // fixture granted the whole portfolio - both scope columns NULL - which is
  // exactly the bleed R-037c spent a session diagnosing and closing: this
  // suite shares one database, `onCallStaffForProperty()` correctly matches a
  // portfolio-wide grant for EVERY property, and so a portfolio-wide fixture
  // is a candidate in every other spec running concurrently. It took eight
  // scoping assertions down with it across seven other files.
  //
  // R-037c's closing note said this would happen again because nothing
  // enforces the rule. It did, four items later, in this file. A grant
  // scoped to its own throwaway property reaches the same 404 and reaches
  // nothing else.
  const entity = await prisma.legalEntity.create({
    data: { name: `Boundary LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Boundary House-${randomUUID().slice(0, 8)}`,
      addressLine1: '9 Dead End',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)

  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'manager' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, propertyId: property.id },
  })
  return staff
}

test.describe('a link that goes nowhere', () => {
  test('a TENANT gets the portal 404, with their own navigation still around it', async ({
    page,
  }) => {
    const { link } = await seedTenant()
    await page.goto(link)

    // A well-formed id that is nobody's record - the shape of a stale link
    // out of an old text message, which is how this screen is actually
    // reached.
    await page.goto(`/portal/maintenance/cm${randomUUID().replace(/-/g, '').slice(0, 20)}`)

    await expect(page.getByRole('heading', { name: 'We could not find that' })).toBeVisible()

    // The part that makes it a bad moment rather than a dead end: this
    // renders INSIDE the portal layout, so the chrome survives.
    await expect(page.getByRole('link', { name: 'Go to your home page' })).toBeVisible()

    // D-10: the portal is a convenience, never the only way to reach a
    // landlord. A dead end is exactly where that has to still be true.
    await expect(page.getByText(/call or text the number on your lease/i)).toBeVisible()

    // And it must NOT accuse them of anything - the most likely cause is our
    // own expired link.
    await expect(page.getByText(/Nothing is wrong with your account/i)).toBeVisible()
  })

  test('STAFF get a 404 that does not confirm whether the record exists', async ({ page }) => {
    const staff = await seedStaff()
    await page.goto('/login')
    await page.getByLabel('Email').fill(staff.email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL(/\/(dashboard|tasks)/)

    await page.goto(`/leases/cm${randomUUID().replace(/-/g, '').slice(0, 20)}`)

    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible()

    // THE LOAD-BEARING ASSERTION. ROLE-01 answers 404 rather than 403 for a
    // record outside your scope, so this one screen serves "no such lease"
    // and "not yours" at once - and this fixture, being property-scoped, can
    // genuinely arrive by either path. It has to name both and pick neither:
    // an edit to "this record does not exist" would make the page an oracle
    // for whether an id is real.
    await expect(page.getByText(/does not exist, or it is outside/i)).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to your queue' })).toBeVisible()
  })
})
