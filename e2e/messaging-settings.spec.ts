import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders } from './fixtures.ts'

// R-266 (PRD 08 B5): the messaging settings page. The portfolio settings are
// one shared row, so this spec puts the business name back when it finishes;
// it never sets a reply assignee, because that would assign every other
// spec's reply Tasks (the unit test covers the assignee rule instead).

const PASSWORD = 'correct-horse-battery-staple'
const stamp = randomUUID().slice(0, 8)
const staffIds: string[] = []
let entityId: string
let property: { id: string; name: string }
let previousName: string | null = null

async function seedStaff(roleKey: 'owner' | 'manager', scoped: boolean) {
  const staff = await prisma.staffUser.create({
    data: {
      email: `msgsettings-${roleKey}-${randomUUID()}@example.test`,
      name: `Settings ${roleKey}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } })
  await prisma.staffAssignment.create({
    data: { staffUserId: staff.id, roleId: role.id, legalEntityId: scoped ? entityId : null },
  })
  return staff
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.beforeAll(async () => {
  previousName =
    (await prisma.messagingSettings.findUnique({ where: { id: 'default' } }))?.businessName ?? null
  const entity = await prisma.legalEntity.create({ data: { name: `Settings LLC-${stamp}`, type: 'LLC' } })
  entityId = entity.id
  property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `Quiet House ${stamp}`,
      addressLine1: '9 Quiet Ln',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
    select: { id: true, name: true },
  })
})

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await prisma.messagingSettings.updateMany({
    where: { id: 'default' },
    data: { businessName: previousName },
  })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: property.id }, data: { active: false } })
})

test('an owner sets the business name and a property’s quiet hours', async ({ page }) => {
  const owner = await seedStaff('owner', false)
  await signIn(page, owner.email)
  await page.goto('/messages')
  await page.getByRole('link', { name: 'Messaging settings' }).click()
  await expect(page.getByRole('heading', { name: 'Messaging settings' })).toBeVisible()

  const name = `Oak Rentals ${stamp}`
  await page.getByLabel('Business name').fill(name)
  await page.getByRole('button', { name: 'Save messaging settings' }).click()
  await expect(page.getByText('Messaging settings saved.')).toBeVisible()
  // This actor's audit row, not the shared settings row: the other Playwright
  // project runs this same test at the same time and overwrites that row.
  const saved = await prisma.auditLog.findFirst({
    where: { action: 'messaging_settings.updated', actorStaffId: owner.id },
    select: { after: true },
  })
  expect(saved?.after).toMatchObject({ businessName: name })

  const from = page.getByLabel(`Quiet from, ${property.name}`, { exact: true })
  const until = page.getByLabel(`Quiet until, ${property.name}`, { exact: true })
  const save = page.getByRole('button', { name: `Save quiet hours for ${property.name}`, exact: true })

  // An equal pair would mean no quiet hours at all.
  await from.selectOption('22')
  await until.selectOption('22')
  await save.click()
  await expect(page.getByText('The start and end must differ')).toBeVisible()

  await from.selectOption('20')
  await until.selectOption('9')
  await save.click()
  await expect(page.getByText('Quiet hours saved.')).toBeVisible()
  await expect
    .poll(async () =>
      prisma.property.findUnique({
        where: { id: property.id },
        select: { quietHoursStart: true, quietHoursEnd: true },
      }),
    )
    .toEqual({ quietHoursStart: 20, quietHoursEnd: 9 })

  const results = await axeScan(page)
  expect(results.violations).toEqual([])
})

test('a manager scoped to one LLC sets only their own quiet hours', async ({ page }) => {
  const manager = await seedStaff('manager', true)
  await signIn(page, manager.email)
  await page.goto('/messages/settings')
  await expect(page.getByRole('heading', { name: 'Quiet hours' })).toBeVisible()
  await expect(page.getByLabel(`Quiet from, ${property.name}`, { exact: true })).toBeVisible()
  // Portfolio-wide settings are not theirs to change.
  await expect(page.getByLabel('Business name')).toHaveCount(0)
  await expect(page.locator('li h3')).toHaveCount(1)
})
