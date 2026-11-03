import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders } from './fixtures.ts'
import { PASSWORD, code } from './platform-fixtures.ts'

// R-299 (PRD 10 §8): an owner exports the whole organisation from
// /settings/export with a code at the press, and downloads the zip.

const PORT = process.env.PORT ?? '3100'
const staffIds: string[] = []

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await prisma.staffAssignment.updateMany({ where: { staffUserId: { in: staffIds } }, data: { revokedAt: new Date() } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
})

test('an owner exports the organisation with a fresh code and downloads one zip', async ({ page }, testInfo) => {
  const tag = `${testInfo.project.name.slice(0, 1)}${randomUUID().slice(0, 8)}`
  const slug = `e2e-export-${tag}`
  const org = await prisma.organization.create({ data: { slug, name: `Export Org ${tag}` } })
  await prisma.legalEntity.create({ data: { orgId: org.id, name: `Export Entity ${tag}`, type: 'LLC' } })
  const email = `export-owner-${tag}@example.test`
  const { secret } = createTotpEnrolment(email)
  const owner = await prisma.staffUser.create({
    data: {
      orgMemberships: { create: { orgId: org.id } },
      email,
      name: 'Export Owner',
      credential: {
        create: { passwordHash: await hashPassword(PASSWORD), mfaSecret: sealSecret(secret), mfaEnrolledAt: new Date() },
      },
    },
  })
  staffIds.push(owner.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: owner.id, roleId: role.id, orgId: org.id } })
  const host = `http://${slug}.orgs.localhost:${PORT}`

  await page.goto(`${host}/login`)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/login\/mfa/)
  await page.getByLabel(/code/i).fill(code(secret))
  await page.getByRole('button', { name: 'Verify' }).click()
  await page.waitForURL(`${host}/dashboard`)

  await page.goto(`${host}/settings/export`)
  await expect(page.getByText('No export has been made yet.')).toBeVisible()
  await axeScan(page)

  await page.getByLabel('Your authenticator code to export').fill('000000')
  await page.getByRole('button', { name: 'Export all organisation data' }).click()
  await expect(page.getByText('That code did not work.')).toBeVisible()
  expect(await prisma.jobRun.count({ where: { orgId: org.id, jobType: 'org.export' } })).toBe(0)

  await page.getByLabel('Your authenticator code to export').fill(code(secret))
  await page.getByRole('button', { name: 'Export all organisation data' }).click()
  await expect(page.getByText(/^Your export has started\./)).toBeVisible()
  const run = await prisma.jobRun.findFirstOrThrow({ where: { orgId: org.id, jobType: 'org.export' } })
  expect(await prisma.auditLog.count({ where: { action: 'org.exported', entityId: run.id, orgId: org.id } })).toBe(1)
  await expect
    .poll(async () => (await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } })).status, { timeout: 30_000 })
    .toBe('SUCCEEDED')

  await page.reload()
  const link = page.getByRole('link', { name: /^Download the export of/ })
  await expect(link).toBeVisible()
  const response = await page.request.get(`${host}/api/org-export/${run.id}`)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toBe('application/zip')
  const body = await response.body()
  expect(body.subarray(0, 4).toString('hex')).toBe('504b0304')
  expect(body.includes(Buffer.from('manifest.json'))).toBe(true)

  // An id that is not this org's export answers as missing (ORG-04).
  expect((await page.request.get(`${host}/api/org-export/${randomUUID()}`)).status()).toBe(404)
})
