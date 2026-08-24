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

// Syndicating a published listing (LEASE-02, R-057).
//
// The adapter's own contract (list/delist, fault injection) is proved in
// apps/web/lib/listings/simulated-adapter.test.ts, and the lease-up ->
// delist chain in apps/web/lib/listings/delist.test.ts. What only a browser
// proves: a PM can actually pick networks, send, and see the result -
// against the real simulated adapter, not a mock.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const listingIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `syndicate-${unique}@example.test`,
      name: `Syndicate Test ${unique}`,
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
    data: { name: `Syndicate LLC-${unique}`, type: 'LLC' },
  })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Syndicate House-${unique}`,
      addressLine1: '30 Feed Builder Ave',
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
      rentCents: 160_000,
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
  // See R-055/R-056's own note: `.click()` resolves before the async
  // redirect a server action's `redirect()` produces, so the very next
  // `page.goto` here can otherwise land back on /login.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

test.afterAll(async () => {
  await prisma.listingLead.deleteMany({ where: { listingId: { in: listingIds } } })
  await prisma.listingSyndication.deleteMany({ where: { listingId: { in: listingIds } } })
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('a PM sends a published listing to networks and sees the result, per network', async ({
  page,
}) => {
  const staff = await createStaff()
  const { property, unit, listing } = await seedPublishedListing()

  await signIn(page, staff.email)
  await page.goto(`/properties/${property.id}/units/${unit.id}/listing/${listing.id}`)

  // Nothing sent yet.
  await expect(page.getByText('Not sent').first()).toBeVisible()

  await page.getByRole('checkbox', { name: 'Zillow' }).check()
  await page.getByRole('checkbox', { name: 'Zumper' }).check()
  await page.getByRole('button', { name: 'Send to selected networks' }).click()

  await expect(page.getByText('Sent to 2 networks.')).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: 'Zillow' })).toContainText('Live')
  await expect(page.getByRole('listitem').filter({ hasText: 'Zumper' })).toContainText('Live')
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Apartments.com' }),
  ).toContainText('Not sent')

  const rows = await prisma.listingSyndication.findMany({ where: { listingId: listing.id } })
  expect(rows).toHaveLength(2)
  expect(rows.every((row) => row.status === 'LISTED' && row.externalId)).toBe(true)

  // Re-selecting an already-LISTED network is idempotent, not a re-send -
  // only the untouched one goes out.
  await page.getByRole('checkbox', { name: 'Zillow' }).check()
  await page.getByRole('checkbox', { name: 'Apartments.com' }).check()
  await page.getByRole('button', { name: 'Send to selected networks' }).click()
  await expect(page.getByText('Sent to 1 network.')).toBeVisible()
})

test('a visit through a tracked syndication link is attributed to that network', async ({
  browser,
}) => {
  const { listing } = await seedPublishedListing()

  const anon = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  const anonPage = await anon.newPage()
  await anonPage.goto(`/listings/${listing.id}?src=ZILLOW`)
  await expect(anonPage.getByText('$1,600.00/mo')).toBeVisible()
  await anon.close()

  await expect
    .poll(() => prisma.listingLead.count({ where: { listingId: listing.id, source: 'ZILLOW' } }))
    .toBe(1)
})
