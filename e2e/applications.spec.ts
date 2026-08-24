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

// The application pipeline (LEASE-03, R-059).
//
// Pure logic is proved in packages/core/applications/validate.test.ts, and
// everything except inviteToApply (staff-actions.ts, session-dependent) and
// the fee's client-side Elements confirmation against a real database in
// apps/web/lib/applications/applications.test.ts - see that file's own
// header for why each is excluded and e2e-only. This spec covers exactly
// those two: the staff invite click, and the browser-visible surface of
// paying a fee (never the Elements iframe itself - AutopayPanel's own
// header states the identical Playwright limitation).

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
      email: `application-${unique}@example.test`,
      name: `Application Test ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedPreScreenedProspect(applicationFeeCents: number | null) {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Application LLC-${unique}`, type: 'LLC' },
  })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Application House-${unique}`,
      addressLine1: '70 Applicant Ave',
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
      rentCents: 165_000,
      applicationFeeCents,
      availableOn: new Date('2026-09-01'),
      publishedAt: new Date(),
    },
  })
  listingIds.push(listing.id)
  const prospect = await prisma.prospect.create({
    data: {
      propertyId: property.id,
      listingId: listing.id,
      firstName: 'Morgan',
      lastName: `Diaz-${randomUUID().slice(0, 6)}`,
      email: `morgan-${randomUUID().slice(0, 8)}@example.test`,
      source: 'direct',
      status: 'PRE_SCREENED',
      // The prospect detail page gates its whole Application section on
      // preScreenRespondedAt, not on status - see that page's own `answered`
      // check.
      preScreenRespondedAt: new Date(),
    },
  })
  prospectIds.push(prospect.id)
  return { property, listing, prospect }
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

async function linkFor(applicantId: string, templateKey: string): Promise<string> {
  const notification = await prisma.notification.findFirstOrThrow({
    where: { recipientType: 'APPLICANT', recipientId: applicantId, templateKey },
    orderBy: { createdAt: 'desc' },
  })
  const match = /\/apply\/([^\s]+)/.exec(notification.body)
  if (!match) throw new Error('no application link found in the rendered notification body')
  return match[1]!
}

const fillApplicantForm = async (page: import('@playwright/test').Page) => {
  await page.getByLabel('Date of birth').fill('1988-05-01')
  await page.getByLabel('Street address').fill('45 Current St')
  await page.getByLabel('City').fill('Houston')
  await page.getByLabel('State').fill('TX')
  await page.getByLabel('Postal code').fill('77003')
  await page.getByLabel('Months at this address').fill('12')
  await page.getByLabel('Monthly income').fill('6000')
}

test.afterAll(async () => {
  await prisma.document.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.screeningReport.deleteMany({
    where: { applicant: { application: { propertyId: { in: propertyIds } } } },
  })
  await prisma.applicant.deleteMany({ where: { application: { propertyId: { in: propertyIds } } } })
  await prisma.application.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.prospect.deleteMany({ where: { id: { in: prospectIds } } })
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('staff invites a prospect, the lead adds a co-applicant, and the household completes with no fee due', async ({
  page,
  browser,
}) => {
  const staff = await createStaff()
  const { prospect } = await seedPreScreenedProspect(null)

  await signIn(page, staff.email)
  await page.goto(`/prospects/${prospect.id}`)
  await page.getByRole('button', { name: 'Invite to apply' }).click()
  await expect(page.getByText('Not invited to apply yet.')).toHaveCount(0)

  const lead = await prisma.applicant.findFirstOrThrow({
    where: { application: { prospectId: prospect.id }, isLead: true },
  })
  const leadToken = await linkFor(lead.id, 'application.invite')

  const leadContext = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  const leadPage = await leadContext.newPage()
  await leadPage.goto(`/apply/${leadToken}`)
  await expect(leadPage.getByRole('heading', { name: /Morgan/ })).toBeVisible()

  await fillApplicantForm(leadPage)
  await leadPage.getByRole('button', { name: 'Submit' }).click()
  await expect(leadPage.getByText('Thanks - your section is complete.')).toBeVisible()

  // The lead adds a co-applicant from their own (still-live) link.
  await leadPage.getByLabel('First name').fill('Riley')
  await leadPage.getByLabel('Last name').fill('Chen')
  await leadPage.getByLabel('Email').fill(`riley-${randomUUID().slice(0, 8)}@example.test`)
  await leadPage.getByRole('button', { name: 'Add co-applicant' }).click()
  await expect(leadPage.getByText('has been sent their own link')).toBeVisible()
  await leadContext.close()

  const coApplicant = await prisma.applicant.findFirstOrThrow({
    where: { application: { prospectId: prospect.id }, isLead: false },
  })
  const coToken = await linkFor(coApplicant.id, 'application.coapplicant_invite')

  const coContext = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  const coPage = await coContext.newPage()
  await coPage.goto(`/apply/${coToken}`)
  await expect(coPage.getByRole('heading', { name: /Riley/ })).toBeVisible()
  // Sees the household, including the lead who is already done.
  await expect(coPage.getByText(/Morgan .* \(started this application\) - done/)).toBeVisible()

  await fillApplicantForm(coPage)
  await coPage.getByRole('button', { name: 'Submit' }).click()
  await expect(coPage.getByText('Thanks - your section is complete.')).toBeVisible()
  await coContext.close()

  // SCREENED, not APPLIED - completing the application (R-060) orders a
  // screening report for both applicants automatically, and the simulated
  // adapter completes it inline in the same request.
  await expect
    .poll(async () => {
      const row = await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })
      return row.status
    })
    .toBe('SCREENED')

  await page.goto(`/prospects/${prospect.id}`)
  await expect(page.getByText(/^Complete \d{4}-\d{2}-\d{2}\.$/)).toBeVisible()
  await expect(page.getByText(/Morgan.*\(lead\).*done/)).toBeVisible()
  await expect(page.getByText(/Riley.*done/)).toBeVisible()
})

test('an application fee is required, and paying it is what completes the applicant', async ({
  page,
  browser,
}) => {
  const staff = await createStaff()
  const { prospect } = await seedPreScreenedProspect(7_500)

  await signIn(page, staff.email)
  await page.goto(`/prospects/${prospect.id}`)
  await page.getByRole('button', { name: 'Invite to apply' }).click()
  await expect(page.getByText('Not invited to apply yet.')).toHaveCount(0)

  const lead = await prisma.applicant.findFirstOrThrow({
    where: { application: { prospectId: prospect.id }, isLead: true },
  })
  expect(lead.feeCents).toBe(7_500)
  const leadToken = await linkFor(lead.id, 'application.invite')

  const anon = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  const anonPage = await anon.newPage()
  await anonPage.goto(`/apply/${leadToken}`)
  await fillApplicantForm(anonPage)
  await anonPage.getByRole('button', { name: 'Submit' }).click()

  // Submitted, but not complete - a fee is still due (never the free-text
  // "Elements" iframe itself, which Playwright cannot drive - see this
  // spec's own header).
  await expect(anonPage.getByRole('heading', { name: 'Application fee' })).toBeVisible()
  await expect(anonPage.getByRole('button', { name: 'Pay application fee' })).toBeVisible()
  await anon.close()

  const afterSubmit = await prisma.applicant.findUniqueOrThrow({ where: { id: lead.id } })
  expect(afterSubmit.formSubmittedAt).not.toBeNull()
  expect(afterSubmit.completedAt).toBeNull()

  // The fee's confirmation is webhook-driven (D-11) and proved directly in
  // applications.test.ts's own projectApplicationFeeEvent tests - this
  // simulates exactly what that projector writes, so the STAFF PAGE's own
  // reading of a paid, complete application (the PRD's "PM sees it in a
  // pipeline view with a completion timestamp") gets real browser coverage
  // without needing a signed Stripe webhook delivery in this suite.
  await prisma.$transaction([
    prisma.applicant.update({
      where: { id: lead.id },
      data: { feePaidAt: new Date(), completedAt: new Date() },
    }),
    prisma.application.updateMany({
      where: { prospectId: prospect.id },
      data: { completedAt: new Date() },
    }),
    prisma.prospect.update({ where: { id: prospect.id }, data: { status: 'APPLIED' } }),
  ])

  await page.goto(`/prospects/${prospect.id}`)
  await expect(page.getByText(/^Complete \d{4}-\d{2}-\d{2}\.$/)).toBeVisible()
  await expect(page.getByText(/Morgan.*\(lead\).*done/)).toBeVisible()
})
