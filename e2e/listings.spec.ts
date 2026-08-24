import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniqueClientHeaders } from './fixtures.ts'

// R-003's login limiter is ten attempts per IP per five minutes, and local
// e2e traffic carries no x-forwarded-for - so without this every spec shares
// one bucket and the full sweep starts refusing sign-ins around test 200.
// See uniqueClientHeaders' own comment: the symptom looks nothing like the
// cause.
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

// Listing creation + hosted listing page (LEASE-01, R-056).
//
// The database queries are proved in apps/web/lib/listings/listings.test.ts
// and the pure disclosure/validation logic in
// packages/core/listings/listings.test.ts. What only a browser proves: a PM
// can actually create a listing, publish it, an ANONYMOUS visitor (no
// signIn() anywhere in this spec's public-page tests) can read the hosted
// page, and unpublishing takes it back down to a 404 - not a login wall,
// since the page is public by design, not token-gated.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const listingIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `listing-${unique}@example.test`,
      name: `Listing Test ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedUnit() {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Listing LLC-${unique}`, type: 'LLC' },
  })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Listing House-${unique}`,
      addressLine1: '20 Hosted Page Lane',
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
  return { property, unit }
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // React 19 resets an uncontrolled field's DOM value once a form action
  // completes, and `.click()` itself resolves before the async redirect
  // does - see R-055's own note on the same race. Without this the very
  // next `page.goto` here can land back on /login.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

test.afterAll(async () => {
  // Leads first, and this spec is the reason the ordering matters: its own
  // anonymous-visitor test loads the hosted listing page, and every visit to
  // that page writes a `ListingLead` (R-057's attribution log). Deleting the
  // listing out from under one violates `ListingLead_listingId_fkey`.
  //
  // Latent rather than always-red because `recordListingLead` is
  // fire-and-forget - the row sometimes lands after teardown has already run,
  // so the failure only appears when the write wins the race. The three specs
  // that already delete leads first (listing-syndication, leasing-analytics,
  // prospects) had the line and this one did not.
  await prisma.listingLead.deleteMany({ where: { listingId: { in: listingIds } } })
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

/// The id the create redirect landed on. Read from the URL rather than
/// looked up, same reasoning leases.spec.ts's own capturedLeaseId gives.
async function capturedListingId(page: import('@playwright/test').Page) {
  // (?!new$) - that also matches the CURRENT url on the create page,
  // ".../listing/new" itself, which resolves the wait instantly and hands
  // back "new" as the id. Same trap leases.spec.ts's own capturedLeaseId
  // documents for its identical create-redirect wait.
  await page.waitForURL(/\/listing\/(?!new$)[a-z0-9]+$/)
  const id = new URL(page.url()).pathname.split('/').pop()!
  listingIds.push(id)
  return id
}

test('a PM creates a listing, publishes it, and an anonymous visitor reads the hosted page', async ({
  page,
  browser,
}) => {
  const staff = await createStaff()
  const { property, unit } = await seedUnit()

  await signIn(page, staff.email)
  await page.goto(`/properties/${property.id}/units/${unit.id}`)
  await page.getByRole('link', { name: 'Create listing' }).click()

  await page.getByLabel('Asking rent (dollars)').fill('1750')
  await page.getByLabel('Asking deposit (dollars)').fill('1750')
  await page.getByLabel('Available on').fill('2026-09-01')
  await page.getByLabel('Requirements').fill('Income at least 3x rent. No prior evictions.')
  await page.getByRole('button', { name: 'Create listing' }).click()

  const listingId = await capturedListingId(page)
  await expect(page.getByText('Draft — not public yet.')).toBeVisible()

  // Not public yet - an anonymous visitor gets a 404, not the page.
  const anonBefore = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  const beforePublish = await anonBefore.newPage()
  const draftResponse = await beforePublish.goto(`/listings/${listingId}`)
  expect(draftResponse?.status()).toBe(404)
  await anonBefore.close()

  await page.getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByText(`/listings/${listingId}`)).toBeVisible()

  // A FRESH, unauthenticated context - this is the whole point of a
  // "public by design" page (route-guards.test.ts's own reasoning): no
  // signIn() call anywhere below.
  const anon = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  const publicPage = await anon.newPage()
  const response = await publicPage.goto(`/listings/${listingId}`)
  expect(response?.status()).toBe(200)

  await expect(publicPage.getByText('$1,750.00/mo')).toBeVisible()
  await expect(publicPage.getByText('2026-09-01')).toBeVisible()
  await expect(publicPage.getByText(/Income at least 3x rent/)).toBeVisible()
  // Disclosures (RISK-06's own row text: "warn with the specific complaint
  // and date" was R-055's; this is LEASE-01's own "deposit amount, fee
  // limits, source-of-income acceptance") - the real seeded Texas rule, not
  // a fixture this spec invented.
  await expect(publicPage.getByText(/does not require acceptance of a specific source/)).toBeVisible()
  await anon.close()

  // Unpublish, and the anonymous visitor is back to 404 - not a login wall.
  await page.getByRole('button', { name: /Unpublish/ }).click()
  await expect(page.getByText('Unpublished — no longer public.')).toBeVisible()

  const anonAfter = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  const afterUnpublish = await anonAfter.newPage()
  const unpublishedResponse = await afterUnpublish.goto(`/listings/${listingId}`)
  expect(unpublishedResponse?.status()).toBe(404)
  await anonAfter.close()
})

test('checking "pets allowed" reveals the policy field, and it is required to create', async ({
  page,
}) => {
  const staff = await createStaff()
  const { property, unit } = await seedUnit()

  await signIn(page, staff.email)
  await page.goto(`/properties/${property.id}/units/${unit.id}/listing/new`)

  await page.getByLabel('Asking rent (dollars)').fill('1500')
  await page.getByLabel('Available on').fill('2026-09-15')
  // Not present until the box is checked - validateListing()'s own rule is
  // that "no pets" needs no explanation, so the field earns its place on
  // screen rather than sitting there unused for every listing that refuses.
  await expect(page.getByLabel('Pet policy')).toHaveCount(0)

  await page.getByRole('checkbox', { name: 'Pets allowed' }).check()
  await expect(page.getByLabel('Pet policy')).toBeVisible()

  await page.getByLabel('Pet policy').fill('Cats and small dogs, $300 deposit.')
  await page.getByRole('button', { name: 'Create listing' }).click()

  await capturedListingId(page)
  await expect(page.getByText('Draft — not public yet.')).toBeVisible()
})
