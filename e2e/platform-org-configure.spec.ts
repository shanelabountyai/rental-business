import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniqueClientHeaders } from './fixtures.ts'
import { CONSOLE, createAdmin, ensureKeeperOwner, retireAdmins, signIn } from './platform-fixtures.ts'

// Org configure (PRD 11 §4.6, R-304b): name and colours, and the slug change.
// A fresh sign-in just proved a code, so the slug change's step-up is already fresh.

const admins: string[] = []
const orgs: string[] = []

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await prisma.organization.updateMany({ where: { id: { in: orgs } }, data: { notificationsEnabled: false } })
  await retireAdmins(admins)
})

test('a platform owner edits the brand and moves the slug', async ({ page }, testInfo) => {
  await ensureKeeperOwner()
  const admin = await createAdmin(true, admins, ['platform_owner'])
  const tag = `${testInfo.project.name.slice(0, 1)}${randomUUID().slice(0, 8)}`
  const slug = `e2e-cfg-${tag}`
  const org = await prisma.organization.create({ data: { name: `Cfg ${tag}`, slug } })
  orgs.push(org.id)

  await signIn(page, admin)
  await page.goto(`${CONSOLE}/platform/orgs/${slug}`)

  // A colour too light for white text is refused, not silently dropped.
  await page.getByLabel('Primary colour').fill('#ffff00')
  await page.getByRole('button', { name: 'Save name and colours' }).click()
  await expect(page.getByText(/would not reach 4.5:1/)).toBeVisible()

  await page.getByLabel('Brand name').fill(`Renamed ${tag}`)
  await page.getByLabel('Primary colour').fill('#1d4ed8')
  await page.getByRole('button', { name: 'Save name and colours' }).click()
  await expect(page.getByText(/Saved\./)).toBeVisible()
  await expect.poll(async () => (await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).colorPrimary).toBe('#1d4ed8')
  expect(await prisma.auditLog.count({ where: { orgId: org.id, action: 'org.configured' } })).toBe(1)

  // Slug change: the typed confirmation must match, then a fresh code.
  const next = `${slug}-b`
  await page.getByLabel('New slug').fill(next)
  await page.getByLabel('Type the current slug to confirm').fill('wrong')
  await page.getByRole('button', { name: 'Change slug' }).click()
  await expect(page.getByText('Type the current slug exactly to confirm.').first()).toBeVisible()

  // React resets an uncontrolled form after an action, so refill both.
  await page.getByLabel('New slug').fill(next)
  await page.getByLabel('Type the current slug to confirm').fill(slug)
  await page.getByRole('button', { name: 'Change slug' }).click()
  await expect(page.getByText(`The slug was changed from ${slug} to ${next}.`)).toBeVisible()
  expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).slug).toBe(next)
  expect(await prisma.auditLog.count({ where: { orgId: org.id, action: 'org.slug_changed' } })).toBe(1)
})

test('a platform owner switches an org’s notifications off and on, with a reason', async ({ page }, testInfo) => {
  await ensureKeeperOwner()
  const admin = await createAdmin(true, admins, ['platform_owner'])
  const tag = `${testInfo.project.name.slice(0, 1)}${randomUUID().slice(0, 8)}`
  const slug = `e2e-ks-${tag}`
  const org = await prisma.organization.create({ data: { name: `Ks ${tag}`, slug } })
  orgs.push(org.id)
  const enabled = async () => (await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).notificationsEnabled

  await signIn(page, admin)
  await page.goto(`${CONSOLE}/platform/orgs/${slug}`)

  await page.getByLabel('Reason for switching notifications off').fill('Runaway reminder loop')
  await page.getByRole('button', { name: 'Switch notifications off' }).click()
  await expect(page.getByText('Notifications are switched off. Nothing is sent')).toBeVisible()
  await expect.poll(enabled).toBe(false)

  // The page re-renders in the other direction; the reason is asked again.
  await page.getByLabel('Reason for switching notifications on').fill('Loop fixed')
  await page.getByRole('button', { name: 'Switch notifications on' }).click()
  await expect(page.getByText('Notifications are on. Anything held')).toBeVisible()
  await expect.poll(enabled).toBe(true)

  const audits = await prisma.auditLog.findMany({
    where: { orgId: org.id, action: 'org.notifications_switched' },
    orderBy: { occurredAt: 'asc' },
    select: { after: true },
  })
  expect(audits.map((a) => a.after)).toEqual([
    { notificationsEnabled: false, reason: 'Runaway reminder loop' },
    { notificationsEnabled: true, reason: 'Loop fixed' },
  ])
})
