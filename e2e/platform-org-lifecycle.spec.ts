import { randomUUID } from 'node:crypto'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniqueClientHeaders } from './fixtures.ts'
import { CONSOLE, createAdmin, ensureKeeperOwner, retireAdmins, signIn } from './platform-fixtures.ts'

// Freeze, schedule offboarding, restore (PRD 11 §4.6, R-300a). A fresh
// sign-in just proved a code, so every step-up here is already fresh.
//
// The owner's own freeze (/settings/export) is not driven here: the only org
// with a signed-in owner in this suite is org #0, which every other spec
// shares, and freezing it would make the rest of the sweep read-only. The
// transition it calls is the same `freezeOrg` lifecycle.test.ts exercises.

const admins: string[] = []
const orgs: string[] = []

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await prisma.organization.updateMany({ where: { id: { in: orgs } }, data: { notificationsEnabled: false } })
  await retireAdmins(admins)
})

test('a platform owner freezes an org, schedules its offboarding and restores it', async ({ page }, testInfo) => {
  await ensureKeeperOwner()
  const admin = await createAdmin(true, admins, ['platform_owner'])
  const tag = `${testInfo.project.name.slice(0, 1)}${randomUUID().slice(0, 8)}`
  const slug = `e2e-life-${tag}`
  const org = await prisma.organization.create({ data: { name: `Life ${tag}`, slug, status: 'ACTIVE' } })
  orgs.push(org.id)
  const row = () => prisma.organization.findUniqueOrThrow({ where: { id: org.id } })

  await signIn(page, admin)
  await page.goto(`${CONSOLE}/platform/orgs/${slug}`)

  // The slug typed back must match.
  await page.getByLabel('Reason for freezing').fill('Owner is leaving the service')
  await page.getByLabel('Type the slug to confirm freezing').fill('wrong')
  await page.getByRole('button', { name: 'Freeze organisation' }).click()
  await expect(page.getByText('Type the slug exactly to confirm.')).toBeVisible()

  await page.getByLabel('Reason for freezing').fill('Owner is leaving the service')
  await page.getByLabel('Type the slug to confirm freezing').fill(slug)
  await page.getByRole('button', { name: 'Freeze organisation' }).click()
  await expect(page.getByText(/^Frozen\. Its people can read and export/)).toBeVisible()
  await expect.poll(async () => (await row()).status).toBe('FROZEN')

  await page.getByLabel('Reason for offboarding').fill('Export delivered')
  await page.getByLabel('Type the slug to confirm offboarding').fill(slug)
  await page.getByRole('button', { name: 'Schedule offboarding' }).click()
  await expect(page.getByText(/^Offboarding is scheduled for /)).toBeVisible()
  await expect.poll(async () => (await row()).offboardAt).not.toBeNull()

  await page.getByLabel('Reason for restoring').fill('Owner changed their mind')
  await page.getByLabel('Type the slug to confirm restoring').fill(slug)
  await page.getByRole('button', { name: 'Restore organisation' }).click()
  await expect(page.getByText(/^Restored\. Everything works again/)).toBeVisible()
  await expect.poll(async () => (await row()).status).toBe('ACTIVE')
  expect((await row()).offboardAt).toBeNull()

  const audits = await prisma.auditLog.findMany({
    where: { orgId: org.id, action: { in: ['org.frozen', 'org.offboard_scheduled', 'org.restored'] } },
    orderBy: { occurredAt: 'asc' },
    select: { action: true, actorType: true },
  })
  expect(audits).toEqual([
    { action: 'org.frozen', actorType: 'PLATFORM' },
    { action: 'org.offboard_scheduled', actorType: 'PLATFORM' },
    { action: 'org.restored', actorType: 'PLATFORM' },
  ])
})
