import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { axeScan, uniqueClientHeaders } from './fixtures.ts'

// R-280 (PRD 09 Q1, D-394): an org's owner connects one entity's QuickBooks
// file on the org's host. The consent stand-in (D-27) sends the browser back
// through the real callback route, which is session-guarded and only
// reachable end to end, then the owner disconnects it.

const PORT = process.env.PORT ?? '3100'
const PASSWORD = 'correct-horse-battery-staple'
const staffIds: string[] = []
const propertyIds: string[] = []
const entityIds: string[] = []
const realms: string[] = []

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

test.afterAll(async () => {
  await prisma.staffAssignment.updateMany({ where: { staffUserId: { in: staffIds } }, data: { revokedAt: new Date() } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.quickBooksConnection.deleteMany({ where: { legalEntityId: { in: entityIds } } })
  await prisma.simulatedQuickBooksGrant.deleteMany({ where: { realmId: { in: realms } } })
})

test('an owner connects an entity to QuickBooks through consent and the callback, then disconnects it', async ({ page }, testInfo) => {
  const tag = `${testInfo.project.name.slice(0, 1)}${randomUUID().slice(0, 8)}`
  const slug = `e2e-qbo-${tag}`
  const org = await prisma.organization.create({ data: { slug, name: `QuickBooks Org ${tag}` } })
  const entity = await prisma.legalEntity.create({ data: { orgId: org.id, name: `Ledger LLC ${tag}`, type: 'LLC' } })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      orgId: org.id,
      legalEntityId: entity.id,
      name: `Books House ${tag}`,
      addressLine1: '1 Ledger Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const email = `qbo-owner-${tag}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      orgMemberships: { create: { orgId: org.id } },
      email,
      name: 'Books Owner',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id, orgId: org.id } })

  const host = `http://${slug}.orgs.localhost:${PORT}`
  await page.goto(`${host}/login`)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(`${host}/dashboard`)

  await page.goto(`${host}/money/quickbooks`)
  await expect(page.getByRole('heading', { name: `Ledger LLC ${tag}` })).toBeVisible()
  await axeScan(page)

  // No basis chosen: refused, because it has no default (D-393).
  await page.getByRole('button', { name: 'Connect QuickBooks' }).click()
  await expect(page.getByText(/Choose cash or accrual/)).toBeVisible()

  await page.getByLabel('Accrual').check()
  await page.getByRole('button', { name: 'Connect QuickBooks' }).click()
  await page.waitForURL(`${host}/money/quickbooks/simulated?**`)
  await expect(page.getByRole('heading', { name: 'Simulated QuickBooks sign-in' })).toBeVisible()
  await axeScan(page)
  const realm = `sim-e2e-${tag}`
  realms.push(realm)
  await page.getByLabel('Company id').fill(realm)
  await page.getByRole('button', { name: 'Allow access' }).click()

  await page.waitForURL(`${host}/money/quickbooks?result=connected`)
  await expect(page.getByText('QuickBooks is connected.')).toBeVisible()
  await expect(page.getByText(realm)).toBeVisible()
  await expect(page.getByText('Accrual', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Connect an entity' })).toHaveCount(0)

  // R-283 (Q9, Q10): the reconciliation page, and both buttons audited.
  await page.getByRole('link', { name: 'Reconcile a month, sync now or replay a day' }).click()
  await expect(page.getByRole('heading', { name: 'QuickBooks reconciliation' })).toBeVisible()
  await expect(page.getByText('Every line of this month is synced.')).toBeVisible()
  await axeScan(page)
  await page.getByRole('button', { name: 'Sync now' }).click()
  await expect(page.getByText('Synced: 0 journal entries posted, 0 excluded.')).toBeVisible()
  await page.getByLabel('Day to replay').fill('2026-03-10')
  await page.getByRole('button', { name: 'Replay day' }).click()
  await expect(page.getByText('No journal is dated that day for this entity.')).toBeVisible()
  const connection = await prisma.quickBooksConnection.findUniqueOrThrow({ where: { legalEntityId: entity.id } })
  await expect
    .poll(() => prisma.auditLog.count({ where: { entityId: connection.id, action: { in: ['integration.sync_requested', 'integration.replayed'] } } }))
    .toBe(2)
  await page.goto(`${host}/money/quickbooks`)

  await page.getByRole('button', { name: `Disconnect Ledger LLC ${tag}` }).click()
  await page.waitForURL(`${host}/money/quickbooks?result=disconnected`)
  await expect(page.getByText('Disconnected from QuickBooks.')).toBeVisible()
  await expect(page.getByText(realm)).toHaveCount(0)
})
