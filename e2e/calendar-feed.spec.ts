import { randomUUID } from 'node:crypto'
import { hashPassword, mintToken } from '@rental/core/auth'
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

// The staff visit calendar (NOTIF-06, R-097c).
//
// The document format is proved character by character in
// packages/core/scheduling/icalendar.test.ts, and the exclusions by a
// source-level test over the query. What only a browser proves is the rest:
// that the feed serves as a real subscribable calendar, that its scope is
// resolved on every fetch rather than frozen into the token, and that
// re-issuing kills the old link.

const PASSWORD = 'correct-horse-battery-staple'
const entityIds: string[] = []
const propertyIds: string[] = []
const staffIds: string[] = []

async function seedProperty(name: string) {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `Cal LLC-${name}-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Cal ${name}-${unique}`,
      addressLine1: `${name} Calendar Way`,
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
    data: { propertyId: property.id, name: `U-${unique}`, status: 'VACANT' },
  })
  return { entity, property, unit, unique }
}

async function createStaff(legalEntityId?: string) {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `cal-${unique}@example.test`,
      name: `Cal Owner ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, legalEntityId },
  })
  return staff
}

async function feedToken(staffId: string) {
  const minted = mintToken('CALENDAR_FEED')
  await prisma.authToken.create({
    data: {
      purpose: 'CALENDAR_FEED',
      tokenHash: minted.tokenHash,
      subjectType: 'StaffUser',
      subjectId: staffId,
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

test.afterAll(async () => {
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('serves a subscribable calendar of the visits in scope, and nothing about the tenant', async ({
  page,
}) => {
  const mine = await seedProperty('Mine')
  const theirs = await seedProperty('Theirs')
  const staff = await createStaff(mine.entity.id)
  const token = await feedToken(staff.id)

  const start = new Date(Date.now() + 2 * 60 * 60_000)
  const prospect = await prisma.prospect.create({
    data: {
      propertyId: mine.property.id,
      listingId: (
        await prisma.listing.create({
          data: {
            propertyId: mine.property.id,
            unitId: mine.unit.id,
            status: 'PUBLISHED',
            rentCents: 150_000,
            availableOn: new Date('2026-09-01'),
            publishedAt: new Date(),
          },
        })
      ).id,
      firstName: 'Nosy',
      lastName: `Prospect-${mine.unique}`,
      email: `nosy-${mine.unique}@example.test`,
      source: 'TEST',
      status: 'SHOWING',
    },
  })
  await prisma.showing.create({
    data: {
      propertyId: mine.property.id,
      unitId: mine.unit.id,
      prospectId: prospect.id,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 30 * 60_000),
    },
  })
  // A visit at a property this person cannot see. The scope is resolved on
  // every fetch, so it must not be here.
  const otherProspect = await prisma.prospect.create({
    data: {
      propertyId: theirs.property.id,
      listingId: (
        await prisma.listing.create({
          data: {
            propertyId: theirs.property.id,
            unitId: theirs.unit.id,
            status: 'PUBLISHED',
            rentCents: 150_000,
            availableOn: new Date('2026-09-01'),
            publishedAt: new Date(),
          },
        })
      ).id,
      firstName: 'Other',
      lastName: `Prospect-${theirs.unique}`,
      // A CHECK requires one contact route - a prospect nobody can reply to
      // is not a lead.
      email: `other-${theirs.unique}@example.test`,
      source: 'TEST',
      status: 'SHOWING',
    },
  })
  await prisma.showing.create({
    data: {
      propertyId: theirs.property.id,
      unitId: theirs.unit.id,
      prospectId: otherProspect.id,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 30 * 60_000),
    },
  })

  const response = await page.request.get(`/api/calendar/${token}`)
  expect(response.status()).toBe(200)
  // A calendar app decides what to do by the content type, not the path.
  expect(response.headers()['content-type']).toContain('text/calendar')
  expect(response.headers()['cache-control']).toContain('no-store')

  const body = await response.text()
  expect(body.startsWith('BEGIN:VCALENDAR')).toBe(true)
  expect(body).toContain(`Showing — ${mine.unit.name}`)
  expect(body).toContain('Mine Calendar Way')

  // Scope, resolved on THIS fetch.
  expect(body).not.toContain('Theirs Calendar Way')
  expect(body).not.toContain(theirs.unit.name)

  // WHAT IT NEVER CARRIES. The address and the time are what somebody
  // standing outside a door needs; a tenant's or prospect's identity in a
  // shared work calendar is a disclosure nobody consented to.
  expect(body).not.toContain('Nosy')
  expect(body).not.toContain(`Prospect-${mine.unique}`)
  expect(body).not.toContain(`nosy-${mine.unique}@example.test`)
})

test('a deactivated staff member’s calendar stops updating on its next poll', async ({ page }) => {
  const seed = await seedProperty('Gone')
  const staff = await createStaff(seed.entity.id)
  const token = await feedToken(staff.id)

  expect((await page.request.get(`/api/calendar/${token}`)).status()).toBe(200)

  await prisma.staffUser.update({ where: { id: staff.id }, data: { active: false } })

  // ROLE-06's "access dies within a minute", for a surface nobody logs out
  // of - which is why the scope is never frozen into the token.
  const after = await page.request.get(`/api/calendar/${token}`)
  expect(after.status()).toBe(404)
})

test('an unknown token is a 404 and says nothing', async ({ page }) => {
  const response = await page.request.get(`/api/calendar/${mintToken('CALENDAR_FEED').token}`)
  // Never a distinguishable "expired": there is nobody to read it, and it
  // would confirm to somebody probing that a token existed.
  expect(response.status()).toBe(404)
  expect(await response.text()).toBe('Not found')
})

test('re-issuing the link stops the old one working', async ({ page }) => {
  const seed = await seedProperty('Rotate')
  const staff = await createStaff(seed.entity.id)
  const old = await feedToken(staff.id)
  expect((await page.request.get(`/api/calendar/${old}`)).status()).toBe(200)

  await signIn(page, staff.email)
  await page.goto('/account')
  const panel = page.getByRole('region', { name: 'Your visit calendar' })
  await panel.getByRole('button', { name: 'Make a new calendar link' }).click()

  const shown = await panel.getByText('/api/calendar/').textContent()
  expect(shown).toBeTruthy()
  const fresh = shown!.trim().split('/api/calendar/')[1]!

  // The whole point of one token per person: a leak is fixed by pressing a
  // button, without rotating anything anybody else depends on.
  expect((await page.request.get(`/api/calendar/${old}`)).status()).toBe(404)
  expect((await page.request.get(`/api/calendar/${fresh}`)).status()).toBe(200)
})
