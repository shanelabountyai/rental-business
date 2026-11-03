import { randomBytes, randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, hashToken, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders, writeStorageBytes } from './fixtures.ts'
import { PASSWORD, code } from './platform-fixtures.ts'

// R-300b (D-388): an offboarded org's final export, from the emailed link.
// The link alone opens nothing; the owner's authenticator code downloads it,
// and only on the org's own host.

const PORT = process.env.PORT ?? '3100'

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test('the link asks for the code, refuses a wrong one, and downloads with the right one', async ({ page }, testInfo) => {
  const tag = `${testInfo.project.name.slice(0, 1)}${randomUUID().slice(0, 8)}`
  const slug = `e2e-final-${tag}`
  const org = await prisma.organization.create({ data: { slug, name: `Final Org ${tag}`, status: 'OFFBOARDED' } })
  const email = `former-${tag}@offboarded.invalid`
  const { secret } = createTotpEnrolment(email)
  const owner = await prisma.staffUser.create({
    data: {
      email,
      name: 'Former staff member',
      active: false,
      credential: { create: { passwordHash: await hashPassword(PASSWORD), mfaSecret: sealSecret(secret), mfaEnrolledAt: new Date() } },
    },
  })
  const storageKey = `org-exports/${org.id}/e2e-${tag}.zip`
  await writeStorageBytes(storageKey, 'PK-final-export')
  const token = randomBytes(32).toString('base64url')
  await prisma.finalExportLink.create({
    data: { orgId: org.id, staffUserId: owner.id, tokenHash: hashToken(token), storageKey, expiresAt: new Date(Date.now() + 60 * 60_000) },
  })
  const host = `http://${slug}.orgs.localhost:${PORT}`

  // Another org's host never honours it.
  await page.goto(`http://localhost:${PORT}/final-export/${token}`)
  await expect(page.getByRole('heading', { name: 'That link cannot be used' })).toBeVisible()

  await page.goto(`${host}/final-export/${token}`)
  await expect(page.getByRole('heading', { name: `Final export of Final Org ${tag}` })).toBeVisible()
  await axeScan(page)
  await page.getByLabel('Authenticator code').fill('000000')
  await page.getByRole('button', { name: 'Download' }).click()
  await expect(page.getByText('That code did not work.')).toBeVisible()

  await page.getByLabel('Authenticator code').fill(code(secret))
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()])
  expect(download.suggestedFilename()).toBe(`final-export-${org.id}.zip`)
})
