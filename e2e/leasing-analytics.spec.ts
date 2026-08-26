import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan } from './fixtures.ts'

// The leasing funnel and maintenance analytics (RPT-06, MAINT-10, R-081c).
//
// The arithmetic is unit-tested in packages/core/metrics/funnel.test.ts and
// maintenance.test.ts. What this file proves is what only a real request can:
// that the funnel counts PEOPLE when the database holds several events per
// person, that a repeat-issue chain is found across real ticket rows, and
// that a merged duplicate does not manufacture one.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const listingIds: string[] = []
const prospectIds: string[] = []
const applicationIds: string[] = []
const applicantIds: string[] = []
const ticketIds: string[] = []
const workOrderIds: string[] = []
const vendorIds: string[] = []

/// The window both pages default to comfortably contains these, and every
/// fixture pins its own dates so a run in December behaves like one in March.
const FROM = '2026-01-01'
const TO = '2026-08-01'
const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`)

async function createStaff() {
  const email = `funnel-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Funnel Test',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return { ...staff, email }
}

async function seedProperty(label: string) {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `${label} LLC-${stamp}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `${label}-${stamp}`,
      addressLine1: '1 Funnel Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${stamp}`, status: 'VACANT' },
  })
  unitIds.push(unit.id)
  const listing = await prisma.listing.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      rentCents: 175_000,
      status: 'PUBLISHED',
      availableOn: new Date('2026-01-01T00:00:00.000Z'),
    },
  })
  listingIds.push(listing.id)
  return { property, unit, listing, stamp }
}

async function seedProspect(
  propertyId: string,
  listingId: string,
  source: string,
  createdAt: Date,
) {
  const stamp = randomUUID().slice(0, 8)
  const prospect = await prisma.prospect.create({
    data: {
      propertyId,
      listingId,
      firstName: 'Pro',
      lastName: `Spect-${stamp}`,
      email: `pro-${stamp}@example.test`,
      source,
      createdAt,
    },
  })
  prospectIds.push(prospect.id)
  return prospect
}

async function seedApprovedApplication(
  propertyId: string,
  listingId: string,
  prospectId: string,
  completedAt: Date,
  decision: string,
) {
  const application = await prisma.application.create({
    data: { propertyId, listingId, prospectId, completedAt },
  })
  applicationIds.push(application.id)
  const applicant = await prisma.applicant.create({
    data: {
      applicationId: application.id,
      isLead: true,
      firstName: 'App',
      lastName: `Licant-${randomUUID().slice(0, 6)}`,
      completedAt,
    },
  })
  applicantIds.push(applicant.id)
  await prisma.screeningReport.create({
    data: {
      applicantId: applicant.id,
      providerId: `sim_${randomUUID().slice(0, 8)}`,
      status: 'COMPLETE',
      criteriaVersion: 1,
      decision,
      decisionNotes: decision === 'APPROVED' ? null : 'Conditional on a larger deposit.',
      decidedAt: completedAt,
    },
  })
  return application
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  await prisma.screeningReport.deleteMany({ where: { applicantId: { in: applicantIds } } })
  await prisma.applicant.deleteMany({ where: { id: { in: applicantIds } } })
  await prisma.application.deleteMany({ where: { id: { in: applicationIds } } })
  await prisma.showing.deleteMany({ where: { prospectId: { in: prospectIds } } })
  await prisma.prospect.deleteMany({ where: { id: { in: prospectIds } } })
  await prisma.listingLead.deleteMany({ where: { listingId: { in: listingIds } } })
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } })
  await prisma.workOrder.deleteMany({ where: { id: { in: workOrderIds } } })
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  // Merged tickets point at their survivor, so the link goes before the rows.
  await prisma.ticket.updateMany({
    where: { id: { in: ticketIds } },
    data: { mergedIntoTicketId: null },
  })
  await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })

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

/// Both reports are portfolio-wide, so a shared test database would let other
/// specs' rows into the totals. Every assertion below therefore scopes to ONE
/// property through the switcher rather than reading a portfolio headline.
async function scopeTo(page: import('@playwright/test').Page, propertyId: string) {
  await page.context().addCookies([
    {
      name: 'rental_scope',
      value: `property:${propertyId}`,
      domain: 'localhost',
      path: '/',
    },
  ])
}

test.describe('the leasing funnel (RPT-06)', () => {
  test('counts people, not bookings, and never converts above 100%', async ({ page }) => {
    const { property, listing } = await seedProperty('Funnel')
    const staff = await createStaff()

    // ONE prospect who rebooked twice. Three Showing rows, one person who
    // viewed the home - counting rows would report 300% of the cohort.
    const rebooker = await seedProspect(property.id, listing.id, 'ZILLOW', at('2026-02-01'))
    for (const day of ['2026-02-05', '2026-02-07', '2026-02-09']) {
      await prisma.showing.create({
        data: {
          propertyId: property.id,
          unitId: unitIds[unitIds.length - 1],
          prospectId: rebooker.id,
          scheduledStart: at(day),
          scheduledEnd: at(day),
          status: 'BOOKED',
        },
      })
    }

    // A second prospect who never viewed and never applied.
    await seedProspect(property.id, listing.id, 'ZILLOW', at('2026-02-02'))

    await signIn(page, staff.email)
    await scopeTo(page, property.id)
    await page.goto(`/reports/leasing?from=${FROM}&to=${TO}`)

    const funnel = page.getByRole('region', { name: 'The funnel' })
    await expect(funnel.getByText('Inquired')).toBeVisible()
    // Two inquiries, one of whom viewed - 50%, not 150%.
    await expect(funnel.getByText('50% of previous')).toBeVisible()
  })

  test('reports an applicant who never booked a showing as skipped, not as conversion', async ({
    page,
  }) => {
    const { property, listing } = await seedProperty('Skip')
    const staff = await createStaff()

    const applicant = await seedProspect(property.id, listing.id, 'DIRECT', at('2026-03-01'))
    await seedApprovedApplication(
      property.id,
      listing.id,
      applicant.id,
      at('2026-03-10'),
      'APPROVED',
    )

    await signIn(page, staff.email)
    await scopeTo(page, property.id)
    await page.goto(`/reports/leasing?from=${FROM}&to=${TO}`)

    const funnel = page.getByRole('region', { name: 'The funnel' })
    // Nobody viewed, so there is no cohort to have converted out of - and the
    // applicant is named as having skipped the stage rather than silently
    // inflating a ratio they were never in.
    await expect(funnel.getByText('1 skipped the previous stage')).toBeVisible()
  })

  test('counts an approve-with-conditions as approved', async ({ page }) => {
    const { property, listing } = await seedProperty('Conditional')
    const staff = await createStaff()

    const prospect = await seedProspect(property.id, listing.id, 'ZUMPER', at('2026-04-01'))
    await seedApprovedApplication(
      property.id,
      listing.id,
      prospect.id,
      at('2026-04-05'),
      'APPROVED_WITH_CONDITIONS',
    )

    await signIn(page, staff.email)
    await scopeTo(page, property.id)
    await page.goto(`/reports/leasing?from=${FROM}&to=${TO}`)

    const sources = page.getByRole('region', { name: 'Channel quality' })
    const row = sources.getByRole('row').filter({ hasText: 'Zumper' })
    await expect(row).toContainText('100%')
  })

  test('keeps anonymous listing visits out of the funnel and in their own table', async ({
    page,
  }) => {
    const { property, listing } = await seedProperty('Visits')
    const staff = await createStaff()

    for (let i = 0; i < 4; i += 1) {
      await prisma.listingLead.create({
        data: { listingId: listing.id, source: 'ZILLOW', occurredAt: at('2026-05-01') },
      })
    }

    await signIn(page, staff.email)
    await scopeTo(page, property.id)
    await page.goto(`/reports/leasing?from=${FROM}&to=${TO}`)

    const leads = page.getByRole('region', { name: 'Listing visits by source' })
    await expect(leads.locator('dt', { hasText: 'Zillow' }).locator('+ dd')).toHaveText('4')

    // Four visits and zero named inquiries: the funnel must still read zero,
    // because a visit is not a person.
    const funnel = page.getByRole('region', { name: 'The funnel' })
    const inquired = funnel.getByRole('listitem').filter({ hasText: 'Inquired' })
    await expect(inquired).toContainText('first stage')
    await expect(inquired.locator('.tabular-nums')).toHaveText('0')
    // And a later stage with no cohort says so, rather than claiming to be
    // the first stage — a null conversion has two causes and one label for
    // both would tell the reader that Approved is where the funnel starts.
    await expect(
      funnel.getByRole('listitem').filter({ hasText: 'Approved' }),
    ).toContainText('nobody reached the previous stage')
  })

  test('names the cost-per-channel gap instead of showing a zero', async ({ page }) => {
    const { property } = await seedProperty('Gap')
    const staff = await createStaff()
    await signIn(page, staff.email)
    await scopeTo(page, property.id)
    await page.goto(`/reports/leasing?from=${FROM}&to=${TO}`)

    await expect(page.getByText(/no ad-spend record anywhere/)).toBeVisible()
  })
})

test.describe('maintenance analytics (MAINT-10)', () => {
  async function seedTicket(
    propertyId: string,
    unitId: string,
    category: string,
    createdAt: Date,
    extra: { closedAt?: Date; priority?: string; mergedIntoTicketId?: string } = {},
  ) {
    const ticket = await prisma.ticket.create({
      data: {
        propertyId,
        unitId,
        category,
        source: 'STAFF',
        description: `Issue ${randomUUID().slice(0, 6)}`,
        priority: (extra.priority ?? 'ROUTINE') as 'ROUTINE',
        status: extra.closedAt ? 'CLOSED' : 'TRIAGED',
        createdAt,
        closedAt: extra.closedAt,
        mergedIntoTicketId: extra.mergedIntoTicketId,
      },
    })
    ticketIds.push(ticket.id)
    return ticket
  }

  test('chains a recurring problem into one repeat rather than cutting it at 90 days', async ({
    page,
  }) => {
    const { property, unit } = await seedProperty('Repeat')
    const staff = await createStaff()

    // Three leaks eighty days apart: one chronic problem spanning 160 days,
    // not two unrelated pairs.
    for (const day of ['2026-01-05', '2026-03-26', '2026-06-14']) {
      await seedTicket(property.id, unit.id, 'PLUMBING', at(day))
    }

    await signIn(page, staff.email)
    await scopeTo(page, property.id)
    await page.goto(`/reports/maintenance?from=${FROM}&to=${TO}`)

    const repeats = page.getByRole('region', { name: /Repeat issues/ })
    await expect(repeats.getByText('3 reports')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Repeat issues — 1 chain' })).toBeVisible()
  })

  test('does not manufacture a repeat out of a merged duplicate', async ({ page }) => {
    const { property, unit } = await seedProperty('Merged')
    const staff = await createStaff()

    // Two people reporting one leak. The second is merged into the first, so
    // this is ONE complaint and must not read as a repeat issue.
    const survivor = await seedTicket(property.id, unit.id, 'PLUMBING', at('2026-02-01'))
    await seedTicket(property.id, unit.id, 'PLUMBING', at('2026-02-02'), {
      mergedIntoTicketId: survivor.id,
    })

    await signIn(page, staff.email)
    await scopeTo(page, property.id)
    await page.goto(`/reports/maintenance?from=${FROM}&to=${TO}`)

    await expect(page.getByText('Nothing came back twice in this window.')).toBeVisible()
  })

  test('reports time to resolve by priority, with every priority present', async ({ page }) => {
    const { property, unit } = await seedProperty('Resolve')
    const staff = await createStaff()

    // Closed 48 hours after it was raised.
    await seedTicket(property.id, unit.id, 'HVAC', at('2026-02-01'), {
      priority: 'EMERGENCY',
      closedAt: at('2026-02-03'),
    })

    await signIn(page, staff.email)
    await scopeTo(page, property.id)
    await page.goto(`/reports/maintenance?from=${FROM}&to=${TO}`)

    const section = page.getByRole('region', { name: 'Time to resolve, by priority' })
    await expect(section.getByText('Emergency')).toBeVisible()
    await expect(section.getByText('2.0 days')).toBeVisible()
    // Present at zero, never omitted - a portfolio with no urgent tickets
    // should read as zero rather than as a missing row.
    await expect(section.getByText('Urgent')).toBeVisible()
    await expect(section.getByText('Routine')).toBeVisible()
  })

  test('reads the reopen counter nothing has read since R-030, over closed jobs only', async ({
    page,
  }) => {
    const { property, unit } = await seedProperty('Reopen')
    const staff = await createStaff()
    const vendor = await prisma.vendor.create({
      data: { name: `Rework-${randomUUID().slice(0, 6)}`, trades: ['plumbing'], w9OnFile: true },
    })
    vendorIds.push(vendor.id)

    // One closed job that came back, one closed job that did not, and one
    // still open. 1 of 2 = 50%; counting the open job would say 33%.
    for (const [reopenCount, closedAt] of [
      [1, at('2026-03-01')],
      [0, at('2026-03-02')],
    ] as const) {
      const job = await prisma.workOrder.create({
        data: {
          propertyId: property.id,
          unitId: unit.id,
          vendorId: vendor.id,
          scope: `Job ${randomUUID().slice(0, 6)}`,
          status: 'CLOSED',
          invoiceCents: 20_000,
          closedAt,
          reopenCount,
          reopenedAt: reopenCount > 0 ? closedAt : null,
        },
      })
      workOrderIds.push(job.id)
    }
    const open = await prisma.workOrder.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        vendorId: vendor.id,
        scope: `Open ${randomUUID().slice(0, 6)}`,
        status: 'ASSIGNED',
      },
    })
    workOrderIds.push(open.id)

    await signIn(page, staff.email)
    await scopeTo(page, property.id)
    await page.goto(`/reports/maintenance?from=${FROM}&to=${TO}`)

    const spend = page.getByRole('region', { name: 'Spend and rework' })
    await expect(spend.getByText('Reopened after being called done (1 of 2)')).toBeVisible()
    await expect(spend.locator('dt', { hasText: 'Reopened' }).locator('+ dd')).toHaveText('50%')
    // Two closed jobs at $200 each; the open one has no cost yet.
    await expect(spend.locator('dt', { hasText: 'Total, jobs closed' }).locator('+ dd')).toHaveText(
      '$400.00',
    )
  })

  test('averages cost per vendor', async ({ page }) => {
    const { property, unit } = await seedProperty('VendorCost')
    const staff = await createStaff()
    const vendor = await prisma.vendor.create({
      data: { name: `Costly-${randomUUID().slice(0, 6)}`, trades: ['hvac'], w9OnFile: true },
    })
    vendorIds.push(vendor.id)

    for (const cents of [10_000, 30_000]) {
      const job = await prisma.workOrder.create({
        data: {
          propertyId: property.id,
          unitId: unit.id,
          vendorId: vendor.id,
          scope: `Job ${randomUUID().slice(0, 6)}`,
          status: 'CLOSED',
          invoiceCents: cents,
          closedAt: at('2026-04-01'),
        },
      })
      workOrderIds.push(job.id)
    }

    await signIn(page, staff.email)
    await scopeTo(page, property.id)
    await page.goto(`/reports/maintenance?from=${FROM}&to=${TO}`)

    const row = page.getByRole('region', { name: 'Cost by vendor' }).getByRole('row').filter({
      hasText: 'Costly-',
    })
    await expect(row).toContainText('$400.00')
    await expect(row).toContainText('$200.00')
  })
})

test.describe('accessibility', () => {
  test('both analytics pages have no detectable violations', async ({ page }) => {
    const { property, listing, unit } = await seedProperty('Axe')
    const staff = await createStaff()
    const prospect = await seedProspect(property.id, listing.id, 'ZILLOW', at('2026-05-02'))
    await prisma.showing.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        prospectId: prospect.id,
        scheduledStart: at('2026-05-04'),
        scheduledEnd: at('2026-05-04'),
        status: 'BOOKED',
      },
    })
    await seedApprovedApplication(
      property.id,
      listing.id,
      prospect.id,
      at('2026-05-10'),
      'APPROVED',
    )
    const vendor = await prisma.vendor.create({
      data: { name: `AxeVendor-${randomUUID().slice(0, 6)}`, trades: ['hvac'], w9OnFile: true },
    })
    vendorIds.push(vendor.id)
    const job = await prisma.workOrder.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        vendorId: vendor.id,
        scope: `Axe ${randomUUID().slice(0, 6)}`,
        status: 'CLOSED',
        invoiceCents: 15_000,
        closedAt: at('2026-05-11'),
      },
    })
    workOrderIds.push(job.id)

    await signIn(page, staff.email)
    await scopeTo(page, property.id)

    for (const path of ['/reports/leasing', '/reports/maintenance']) {
      await page.goto(`${path}?from=${FROM}&to=${TO}`)
      const results = await axeScan(page)
      expect(results.violations).toEqual([])
    }
  })
})
