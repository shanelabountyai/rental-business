import { randomUUID } from 'node:crypto'
import { hashPassword, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// The prospect pipeline (LEASE-07, R-058).
//
// Pure logic is proved in packages/core/prospects/validate.test.ts, and
// everything except submitInquiry/advanceProspectStage against a real
// database in apps/web/lib/prospects/prospects.test.ts (both are
// session-or-request-scope-dependent and can only be exercised through a
// browser - see that file's own header). This spec covers exactly those two
// plus the two public pages end to end.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const listingIds: string[] = []
const prospectIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `prospect-${unique}@example.test`,
      name: `Prospect Test ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedPublishedListing() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Prospect LLC-${unique}`, type: 'LLC' },
  })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Prospect House-${unique}`,
      addressLine1: '50 Pipeline Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'VACANT' },
  })
  unitIds.push(unit.id)
  const listing = await prisma.listing.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'PUBLISHED',
      rentCents: 155_000,
      availableOn: new Date('2026-09-01'),
      publishedAt: new Date(),
    },
  })
  listingIds.push(listing.id)
  return { property, unit, listing }
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

test.beforeAll(async () => {
  // Local e2e traffic carries no x-forwarded-for header, so
  // clientIp() in lib/prospects/actions.ts falls back to the loopback
  // address (observed as 'prospect-inquiry:::1') - every anonymous
  // inquiry from every browser project and every past run of this spec
  // today shares that ONE bucket. Five real submissions anywhere this
  // session is enough to trip RATE_LIMITS.prospectInquiry and fail the
  // next run with no app bug involved. Production always has a real
  // per-visitor client IP behind Vercel, so this bucket collision
  // cannot happen there. Matched by prefix, not exact key, since the
  // loopback address's exact form isn't a contract worth pinning.
  await prisma.rateLimitCounter.deleteMany({
    where: { key: { startsWith: 'prospect-inquiry:' } },
  })
})

test.afterAll(async () => {
  await prisma.prospect.deleteMany({ where: { id: { in: prospectIds } } })
  await prisma.listingLead.deleteMany({ where: { listingId: { in: listingIds } } })
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('an anonymous visitor inquires, and the pipeline shows the inquiry', async ({
  page,
  browser,
}) => {
  const staff = await createStaff()
  const { listing } = await seedPublishedListing()
  // Unique per run - two browser projects run this test concurrently, and a
  // literal "Priya Patel" from each would collide in the SAME owner's
  // portfolio-wide /prospects list (getByRole('link') strict-mode violation
  // on two matching rows).
  const lastName = `Patel-${randomUUID().slice(0, 8)}`

  const anon = await browser.newContext()
  const anonPage = await anon.newPage()
  await anonPage.goto(`/listings/${listing.id}?src=ZILLOW`)
  await anonPage.getByLabel('First name').fill('Priya')
  await anonPage.getByLabel('Last name').fill(lastName)
  await anonPage.getByLabel('Email').fill(`priya-${randomUUID().slice(0, 8)}@example.test`)
  await anonPage.getByRole('button', { name: 'Ask about this listing' }).click()
  await expect(anonPage.getByText(/check your email or phone/)).toBeVisible()
  await anon.close()

  await expect
    .poll(() => prisma.prospect.count({ where: { listingId: listing.id } }))
    .toBe(1)
  const prospect = await prisma.prospect.findFirstOrThrow({ where: { listingId: listing.id } })
  prospectIds.push(prospect.id)
  expect(prospect.source).toBe('ZILLOW')
  expect(prospect.status).toBe('INQUIRY')

  await signIn(page, staff.email)
  await page.goto('/prospects')
  await expect(page.getByRole('link', { name: new RegExp(lastName) })).toBeVisible()

  await page.getByRole('link', { name: new RegExp(lastName) }).click()
  await expect(page.getByRole('heading', { name: `Priya ${lastName}` })).toBeVisible()
  await expect(page.getByText('Not sent yet.')).toHaveCount(0)
})

test('a prospect answers the identical five questions, and staff moves the pipeline forward', async ({
  page,
  browser,
}) => {
  const staff = await createStaff()
  const { listing } = await seedPublishedListing()

  const prospect = await prisma.prospect.create({
    data: {
      propertyId: listing.propertyId,
      listingId: listing.id,
      firstName: 'Marcus',
      lastName: `Lee-${randomUUID().slice(0, 6)}`,
      email: `marcus-${randomUUID().slice(0, 8)}@example.test`,
      source: 'direct',
    },
  })
  prospectIds.push(prospect.id)

  // Minted through core, not through the app's server-only issueToken -
  // Playwright cannot import a `server-only` module (same reasoning
  // verify-link.spec.ts's own comment gives for the identical mint).
  const minted = mintToken('PROSPECT_PRESCREEN')
  await prisma.authToken.create({
    data: {
      purpose: 'PROSPECT_PRESCREEN',
      tokenHash: minted.tokenHash,
      subjectType: 'Prospect',
      subjectId: prospect.id,
      expiresAt: minted.expiresAt,
    },
  })

  const anon = await browser.newContext()
  const anonPage = await anon.newPage()
  await anonPage.goto(`/prescreen/${minted.token}`)
  await expect(anonPage.getByRole('heading', { name: /Marcus/ })).toBeVisible()

  await anonPage.getByLabel('When would you move in?').fill('2026-10-01')
  await anonPage.getByLabel('How many people would live there?').fill('2')
  await anonPage.getByLabel('Household income range').selectOption('RANGE_3000_5000')
  await anonPage.getByRole('radio', { name: 'No' }).check()
  await anonPage.getByRole('button', { name: 'Submit' }).click()
  await expect(anonPage.getByRole('heading', { name: 'Thanks' })).toBeVisible()

  // The same link cannot be reused - both reads are once-only.
  await anonPage.goto(`/prescreen/${minted.token}`)
  await expect(anonPage.getByRole('heading', { name: 'Thanks' })).toBeVisible()
  await anon.close()

  const after = await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })
  expect(after.status).toBe('PRE_SCREENED')
  expect(after.incomeRange).toBe('RANGE_3000_5000')

  await signIn(page, staff.email)
  await page.goto(`/prospects/${prospect.id}`)
  await expect(page.getByText('$3,000–$5,000/mo')).toBeVisible()

  await page.getByLabel('Move to stage').selectOption('SHOWING')
  await page.getByRole('button', { name: 'Update' }).click()

  await expect
    .poll(async () => {
      const row = await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })
      return row.status
    })
    .toBe('SHOWING')
})
