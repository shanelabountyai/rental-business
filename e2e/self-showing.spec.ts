import { randomUUID } from 'node:crypto'
import { hashPassword, mintToken } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// Smart-lockbox self-showings (LEASE-08, R-094).
//
// The decision logic is proved in packages/core/scheduling/self-showing.test.ts
// and everything that touches the device in
// apps/web/lib/showings/self-showing.test.ts - the simulator holds the lock's
// codes in the server process, so a browser can drive the pages but can never
// make somebody type a code at a door.
//
// What only a browser proves is the part a stranger actually meets: that the
// page asks who they are before it will say anything, that the code appears
// on the page and in no message, and that pulling it takes the code off that
// page on the next refresh.

const PASSWORD = 'correct-horse-battery-staple'
const entityIds: string[] = []
const propertyIds: string[] = []
const staffIds: string[] = []
const prospectIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `selfshow-${unique}@example.test`,
      name: `Self Showing Owner ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedLockedUnit(status: 'VACANT' | 'OCCUPIED' = 'VACANT') {
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({
    data: { name: `SelfShow LLC-${unique}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `SelfShow House-${unique}`,
      addressLine1: '12 Keypad Close',
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
    data: { propertyId: property.id, name: `U-${unique}`, status },
  })
  const listing = await prisma.listing.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'PUBLISHED',
      rentCents: 150_000,
      availableOn: new Date('2026-09-01'),
      publishedAt: new Date(),
    },
  })
  const lock = await prisma.smartLock.create({
    data: { unitId: unit.id, externalId: `dev-${unique}`, label: 'Front door keypad' },
  })
  return { entity, property, unit, listing, lock, unique }
}

async function seedProspect(
  seed: Awaited<ReturnType<typeof seedLockedUnit>>,
  name: { first: string; last: string },
) {
  const prospect = await prisma.prospect.create({
    data: {
      propertyId: seed.property.id,
      listingId: seed.listing.id,
      firstName: name.first,
      lastName: name.last,
      email: `${randomUUID().slice(0, 8)}@example.test`,
      source: 'TEST',
      status: 'SHOWING',
    },
  })
  prospectIds.push(prospect.id)
  return prospect
}

/// A booking whose slot is happening right now, so the code is inside its
/// window - which is the only state in which the page shows one.
async function bookedNow(seed: Awaited<ReturnType<typeof seedLockedUnit>>, prospectId: string) {
  const start = new Date()
  const showing = await prisma.showing.create({
    data: {
      propertyId: seed.property.id,
      unitId: seed.unit.id,
      prospectId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 30 * 60_000),
    },
  })
  // Minted directly - `issueToken()` is server-only and cannot load into
  // Playwright's plain-Node context, the same reason showings.spec.ts mints
  // its own.
  const minted = mintToken('SHOWING_ACCESS')
  await prisma.authToken.create({
    data: {
      purpose: 'SHOWING_ACCESS',
      tokenHash: minted.tokenHash,
      subjectType: 'Showing',
      subjectId: showing.id,
      expiresAt: minted.expiresAt,
    },
  })
  return { showing, token: minted.token }
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

test('a prospect confirms who they are and the page — and only the page — shows the code', async ({
  page,
}) => {
  const seed = await seedLockedUnit()
  const prospect = await seedProspect(seed, { first: 'Ada', last: 'Lovelace' })
  const { showing, token } = await bookedNow(seed, prospect.id)

  await page.goto(`/showings/access/${token}`)
  await expect(page.getByRole('heading', { name: 'Your viewing' })).toBeVisible()
  // Nothing is offered before they say who they are.
  await expect(page.getByText(/Your entry code/)).toHaveCount(0)
  await expect(page.getByText('We do not keep a copy of your ID')).toBeVisible()

  await page
    .getByLabel('Your name exactly as it is printed on your photo ID')
    .fill('Ada B. Lovelace')
  await page.getByRole('button', { name: 'Confirm who I am' }).click()

  await expect(page.getByText('Your entry code')).toBeVisible()
  const access = await prisma.showingAccess.findUniqueOrThrow({
    where: { showingId: showing.id },
    include: { identityCheck: true },
  })
  expect(access.identityCheck.result).toBe('VERIFIED')

  // NO PHOTO ID ANYWHERE (D-108's rule, applied to a stranger). The check is
  // four columns and a provider reference; there is no Document, and there
  // never will be one for this.
  expect(
    await prisma.document.count({ where: { propertyId: seed.property.id } }),
  ).toBe(0)

  // The code is not in any message we sent, which is what makes the kill
  // below mean anything - a code pasted into an SMS is live for as long as
  // the SMS exists.
  const messages = await prisma.notification.findMany({
    where: { recipientId: prospect.id },
    select: { body: true },
  })
  const digits = /\b\d{6}\b/
  for (const message of messages) expect(message.body).not.toMatch(digits)
})

test('the name on the ID has to be the name that booked it', async ({ page }) => {
  const seed = await seedLockedUnit()
  const prospect = await seedProspect(seed, { first: 'Grace', last: 'Hopper' })
  const { showing, token } = await bookedNow(seed, prospect.id)

  await page.goto(`/showings/access/${token}`)
  await page
    .getByLabel('Your name exactly as it is printed on your photo ID')
    .fill('Charles Babbage')
  await page.getByRole('button', { name: 'Confirm who I am' }).click()

  // A genuine document belonging to somebody else is the case this whole
  // feature exists to catch, and the provider cannot catch it - only this
  // system knows who booked the slot (D-27).
  await expect(page.getByText('does not match the name this viewing was booked under')).toBeVisible()
  expect(await prisma.showingAccess.count({ where: { showingId: showing.id } })).toBe(0)
})

test('pulling the code takes it off the prospect’s page', async ({ page, browser }) => {
  const seed = await seedLockedUnit()
  const staff = await createStaff()
  const prospect = await seedProspect(seed, { first: 'Mary', last: 'Jackson' })
  const { showing, token } = await bookedNow(seed, prospect.id)

  const prospectContext = await browser.newContext()
  const prospectPage = await prospectContext.newPage()
  await prospectPage.goto(`/showings/access/${token}`)
  await prospectPage
    .getByLabel('Your name exactly as it is printed on your photo ID')
    .fill('Mary Jackson')
  await prospectPage.getByRole('button', { name: 'Confirm who I am' }).click()
  await expect(prospectPage.getByText('Your entry code')).toBeVisible()

  await signIn(page, staff.email)
  await page.goto(`/properties/${seed.property.id}/units/${seed.unit.id}`)
  const panel = page.getByRole('region', { name: 'Smart lock and self-showings' })
  // `exact`, because the panel also prints the name the ID gave on its own
  // line - two substring matches for one person.
  await expect(panel.getByText('Mary Jackson', { exact: true })).toBeVisible()
  await panel.getByLabel('Why the code is being pulled').fill('The house was let this morning.')
  await panel.getByRole('button', { name: 'Pull this entry code now' }).click()
  // The PERSISTED outcome, not the action's transient notice: a successful
  // revoke unmounts the form that would have rendered the notice, so waiting
  // on that would wait for something that can never appear. This line is on
  // the row and is still there tomorrow.
  await expect(panel.getByText('The house was let this morning.')).toBeVisible()

  // The decision is re-run on every render, so the prospect's next refresh is
  // when it stops - no message has to be recalled and nothing has to expire.
  await prospectPage.reload()
  await expect(prospectPage.getByText('Your entry code')).toHaveCount(0)
  await expect(prospectPage.getByText('has been cancelled')).toBeVisible()
  await prospectContext.close()

  const access = await prisma.showingAccess.findUniqueOrThrow({
    where: { showingId: showing.id },
  })
  expect(access.revokedReason).toBe('The house was let this morning.')
  expect(access.revokedByStaffId).toBe(staff.id)
})

test('an occupied unit is never offered on your own, however it was booked', async ({ page }) => {
  const seed = await seedLockedUnit('OCCUPIED')
  const prospect = await seedProspect(seed, { first: 'Katherine', last: 'Johnson' })
  const { token } = await bookedNow(seed, prospect.id)

  await page.goto(`/showings/access/${token}`)
  // An unaccompanied code on an occupied home is a stranger with a key to
  // somebody's house, and it outranks every other reason to refuse - so the
  // ID form is not even offered.
  await expect(page.getByText('Somebody is living here now')).toBeVisible()
  await expect(
    page.getByLabel('Your name exactly as it is printed on your photo ID'),
  ).toHaveCount(0)
})

test('booking a unit with a lock is self-serve, and raises no escort task', async ({ page }) => {
  const seed = await seedLockedUnit()
  const prospect = await seedProspect(seed, { first: 'Riley', last: 'Booker' })

  const minted = mintToken('SHOWING_BOOKING')
  await prisma.authToken.create({
    data: {
      purpose: 'SHOWING_BOOKING',
      tokenHash: minted.tokenHash,
      subjectType: 'Prospect',
      subjectId: prospect.id,
      expiresAt: minted.expiresAt,
    },
  })

  await page.goto(`/showings/${minted.token}`)
  await page.getByLabel('Pick a time').selectOption({ index: 1 })
  await page.getByRole('button', { name: 'Book this showing' }).click()
  await expect(page.getByRole('heading', { name: 'You’re booked' })).toBeVisible()

  const showing = await prisma.showing.findFirstOrThrow({ where: { prospectId: prospect.id } })
  // R-064 raises an escort Task for every showing; a self-serve one must not,
  // or somebody is sent to a viewing nobody is attending.
  expect(
    await prisma.task.count({ where: { subjectType: 'Showing', subjectId: showing.id } }),
  ).toBe(0)

  // And the access link goes out as its own message - not buried in the
  // confirmation, which is the one a prospect has to find again while
  // standing outside.
  await expect
    .poll(() =>
      prisma.notification.count({
        where: { recipientId: prospect.id, templateKey: 'showing.self_access' },
      }),
    )
    .toBeGreaterThan(0)

  // The confirmation must not promise an escort that is not coming.
  // The EMAIL rendering specifically: the SMS confirmation is two lines and
  // has never promised anybody an escort, so asserting against whichever
  // channel happened to be written first would pass for the wrong reason.
  const confirmation = await prisma.notification.findFirstOrThrow({
    where: { recipientId: prospect.id, templateKey: 'showing.scheduled', channel: 'EMAIL' },
  })
  expect(confirmation.body).not.toContain('will meet you there')
  expect(confirmation.body).toContain('let yourself in')
})
