import { randomUUID } from 'node:crypto'
import { hashPassword, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone, uniqueClientHeaders } from './fixtures.ts'

// Self-serve showing booking (LEASE-08, R-064).
//
// Pure slot logic is proved directly in
// packages/core/scheduling/showings.test.ts, and everything session-less
// (bookShowing, sendShowingInvite, the reminder sweep) against a real
// database in apps/web/lib/showings/showings.test.ts. This spec covers what
// neither can: the public pages, and cancelShowing (session-dependent,
// requirePermission - same wall every staff-actions.ts draws).

const PASSWORD = 'correct-horse-battery-staple'
const entityIds: string[] = []
const propertyIds: string[] = []
const staffIds: string[] = []
const tenantIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `showing-${unique}@example.test`,
      name: `Showing Manager ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedListing(unitStatus: 'VACANT' | 'OCCUPIED') {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Showing LLC-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Showing House-${unique}`,
      addressLine1: '77 Open House Ln',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
      yearBuilt: 2015,
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: unitStatus },
  })
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

  let tenant = null
  if (unitStatus === 'OCCUPIED') {
    tenant = await prisma.tenant.create({
      data: {
        firstName: 'Resident',
        lastName: `Showing-${unique}`,
        email: `resident-${unique}@example.test`,
        phone: uniquePhone(),
      },
    })
    tenantIds.push(tenant.id)
    const lease = await prisma.lease.create({
      data: {
        propertyId: property.id,
        unitId: unit.id,
        status: 'ACTIVE',
        startsOn: new Date('2025-01-01'),
        rentCents: 155_000,
      },
    })
    await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true } })
  }

  return { property, unit, listing, tenant }
}

async function mintShowingToken(prospectId: string): Promise<string> {
  // Minted directly rather than through issueToken() - that helper is
  // server-only and cannot load into Playwright's plain-Node context, same
  // reason e2e/lease-esign.spec.ts mints its own LEASE_SIGN token.
  const minted = mintToken('SHOWING_BOOKING')
  await prisma.authToken.create({
    data: {
      purpose: 'SHOWING_BOOKING',
      tokenHash: minted.tokenHash,
      subjectType: 'Prospect',
      subjectId: prospectId,
      expiresAt: minted.expiresAt,
    },
  })
  return minted.token
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

test.beforeAll(async () => {
  // Same collision this spec's siblings already document: local e2e traffic
  // carries no x-forwarded-for, so every anonymous inquiry across every
  // browser project shares one prospect-inquiry rate-limit bucket.
  await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: 'prospect-inquiry:' } } })
})

test.afterAll(async () => {
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('a prospect self-books a vacant-unit showing, raising an escort task, and staff can cancel it', async ({
  page,
  browser,
}) => {
  const staff = await createStaff()
  const { listing, unit } = await seedListing('VACANT')
  const lastName = `Booker-${randomUUID().slice(0, 8)}`

  const anon = await browser.newContext({ extraHTTPHeaders: uniqueClientHeaders() })
  const anonPage = await anon.newPage()
  await anonPage.goto(`/listings/${listing.id}`)
  await anonPage.getByLabel('First name').fill('Riley')
  await anonPage.getByLabel('Last name').fill(lastName)
  await anonPage.getByLabel('Email').fill(`riley-${randomUUID().slice(0, 8)}@example.test`)
  await anonPage.getByRole('button', { name: 'Ask about this listing' }).click()
  await expect(anonPage.getByText(/check your email or phone/)).toBeVisible()

  const prospect = await prisma.prospect.findFirstOrThrow({ where: { listingId: listing.id } })

  const prescreenMinted = mintToken('PROSPECT_PRESCREEN')
  await prisma.authToken.create({
    data: {
      purpose: 'PROSPECT_PRESCREEN',
      tokenHash: prescreenMinted.tokenHash,
      subjectType: 'Prospect',
      subjectId: prospect.id,
      expiresAt: prescreenMinted.expiresAt,
    },
  })
  await anonPage.goto(`/prescreen/${prescreenMinted.token}`)
  await anonPage.getByLabel('When would you move in?').fill('2026-10-01')
  await anonPage.getByLabel('How many people would live there?').fill('1')
  await anonPage.getByLabel('Household income range').selectOption('RANGE_3000_5000')
  await anonPage.getByRole('radio', { name: 'No' }).check()
  await anonPage.getByRole('button', { name: 'Submit' }).click()
  await expect(anonPage.getByRole('heading', { name: 'Thanks' })).toBeVisible()

  // Answering pre-screening auto-sends the showing invite (LEASE-08) - read
  // the token back out of the rendered notification body, same technique
  // apps/web/lib/prospects/prospects.test.ts's own tokenFor() uses.
  const inviteWhere = {
    recipientType: 'PROSPECT' as const,
    recipientId: prospect.id,
    templateKey: 'showing.invite',
  }
  await expect.poll(() => prisma.notification.count({ where: inviteWhere })).toBeGreaterThan(0)
  const invite = await prisma.notification.findFirstOrThrow({ where: inviteWhere })
  const match = /\/showings\/(\S+)/.exec(invite.body)
  if (!match) throw new Error('no showing link found in the rendered notification body')

  await anonPage.goto(`/showings/${match[1]}`)
  await expect(anonPage.getByRole('heading', { name: /Hi Riley/ })).toBeVisible()
  await anonPage.getByLabel('Pick a time').selectOption({ index: 1 })
  await anonPage.getByRole('button', { name: 'Book this showing' }).click()

  // The page refreshes on completion (the token is now burned) and the
  // "already used" branch IS the confirmation - see this page's own header
  // for why there is no separate transient "thanks" screen.
  await expect(anonPage.getByRole('heading', { name: 'You’re booked' })).toBeVisible()
  await anon.close()

  const showing = await prisma.showing.findFirstOrThrow({ where: { prospectId: prospect.id } })
  expect(showing.status).toBe('BOOKED')
  expect(showing.entryNoticeId).toBeNull()

  await expect
    .poll(async () => (await prisma.prospect.findUniqueOrThrow({ where: { id: prospect.id } })).status)
    .toBe('SHOWING')

  const task = await prisma.task.findFirstOrThrow({
    where: { subjectType: 'Showing', subjectId: showing.id },
  })
  expect(task.type).toBe('escort_showing')
  expect(task.status).toBe('OPEN')

  await signIn(page, staff.email)
  await page.goto(`/prospects/${prospect.id}`)
  await expect(page.getByText(new RegExp(unit.name))).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  await expect
    .poll(async () => (await prisma.showing.findUniqueOrThrow({ where: { id: showing.id } })).status)
    .toBe('CANCELED')
  await expect
    .poll(async () => (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status)
    .toBe('CANCELED')
})

test('an occupied unit\'s showing generates and serves the tenant entry notice', async ({ page }) => {
  const { listing, unit, tenant } = await seedListing('OCCUPIED')
  const prospect = await prisma.prospect.create({
    data: {
      propertyId: listing.propertyId,
      listingId: listing.id,
      firstName: 'Avery',
      lastName: `Occupied-${randomUUID().slice(0, 6)}`,
      email: `avery-${randomUUID().slice(0, 8)}@example.test`,
      source: 'direct',
      status: 'PRE_SCREENED',
      preScreenRespondedAt: new Date(),
    },
  })
  const token = await mintShowingToken(prospect.id)

  await page.goto(`/showings/${token}`)
  await expect(page.getByRole('heading', { name: /Hi Avery/ })).toBeVisible()
  await page.getByLabel('Pick a time').selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Book this showing' }).click()
  await expect(page.getByRole('heading', { name: 'You’re booked' })).toBeVisible()

  const showing = await prisma.showing.findFirstOrThrow({ where: { prospectId: prospect.id } })
  expect(showing.entryNoticeId).not.toBeNull()
  // Every slot offered to an occupied unit already clears the 24h TX notice
  // period - see availableSlotsFor's own earliestCompliantStart floor.
  expect(showing.scheduledStart.getTime()).toBeGreaterThanOrEqual(Date.now() + 23 * 3_600_000)

  const notice = await prisma.notice.findUniqueOrThrow({ where: { id: showing.entryNoticeId! } })
  expect(notice.type).toBe('ENTRY_NOTICE')

  await expect
    .poll(() =>
      prisma.notification.findFirst({
        where: { recipientType: 'TENANT', recipientId: tenant!.id, templateKey: 'entry.notice' },
      }),
    )
    .not.toBeNull()
})
