import { randomUUID } from 'node:crypto'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { uniquePhone } from './fixtures.ts'

// Renewals through the browser (LEASE-09, R-065).
//
// The rent-increase check itself is proved exhaustively in
// packages/core/leases/renewal.test.ts (pure) and
// apps/web/lib/leases/renewal-check.test.ts (against a real
// JurisdictionRule); the two scheduled jobs are proved against directly-
// seeded rows in their own *-job.test.ts files. What only a browser proves
// is here: that a PM can actually draft a renewal offer and see it land as
// a real successor lease.
//
// A DEDICATED JURISDICTION STATE per test, never used by any real property,
// rather than touching the shared TX seed row every other spec's fixtures
// also read - the same isolation renewal-check.test.ts already uses.
//
// PER TEST, AND THAT IS THE POINT. Both tests here seed a rent-increase cap,
// and they seed DIFFERENT ones - 10% and 5% - because one asserts an increase
// inside the cap and the other asserts one over it. Sharing a single state
// code made them the same row: `@@unique([state, jurisdiction, version])`
// means only one can exist, and `rulesFor` reads every rule for a state before
// choosing, so whichever landed second decided the answer for both. The
// within-the-cap test then submitted 6.7% against the other test's 5% cap, was
// correctly refused, never redirected, and sat on `waitForURL` until the 60s
// test timeout.
//
// It failed on EVERY full sweep and was invisible, because `retries: 1`
// reports a test that fails once and passes as **flaky** and a run with flaky
// tests still exits 0. Verified by running the test alone (passes) against the
// file (fails, deterministically, in both browser projects).
//
// This is CLAUDE.md's "a magic fixture value is only isolated if exactly one
// file uses it", one level down: exactly one TEST.

const PASSWORD = 'correct-horse-battery-staple'
/// Inside the cap. Nothing else in the repo uses either code.
const STATE_UNDER_CAP = 'ZU'
/// Over it.
const STATE_OVER_CAP = 'ZO'

const staffIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const tenantIds: string[] = []
const leaseIds: string[] = []
const ruleIds: string[] = []

async function createStaff() {
  const unique = randomUUID().slice(0, 8)
  const staff = await prisma.staffUser.create({
    data: {
      email: `renewal-${unique}@example.test`,
      name: `Renewal Test ${unique}`,
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

async function seedJurisdictionRule(overrides: {
  state: string
  rentIncreaseCapPercentBps?: number | null
  rentIncreaseNoticeDays?: number | null
}) {
  const rule = await prisma.jurisdictionRule.create({
    data: {
      state: overrides.state,
      version: 1,
      effectiveFrom: new Date('2020-01-01'),
      graceDays: 0,
      lateFeeType: 'NONE',
      rentIncreaseCapPercentBps: overrides.rentIncreaseCapPercentBps,
      rentIncreaseNoticeDays: overrides.rentIncreaseNoticeDays,
      paymentAllocationOrder: [],
    },
  })
  ruleIds.push(rule.id)
  return rule
}

async function seedRunningLease(overrides: { state: string; endsOn?: string }) {
  const endsOn = overrides.endsOn ?? '2026-12-31'
  const unique = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({ data: { name: `Renewal LLC-${unique}`, type: 'LLC' } })
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Renewal House-${unique}`,
      addressLine1: '7 Renewal Way',
      city: 'Somewhere',
      state: overrides.state,
      postalCode: '00000',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${unique}`, status: 'OCCUPIED' },
  })
  unitIds.push(unit.id)
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Rosa', lastName: `Renewer-${unique}`, email: `rosa-${unique}@example.test`, phone: uniquePhone() },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      endsOn: new Date(`${endsOn}T00:00:00Z`),
      rentCents: 150_000,
    },
  })
  leaseIds.push(lease.id)
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id, isPrimary: true } })
  return { property, unit, tenant, lease }
}

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  const strayLeases = await prisma.lease.findMany({ where: { unitId: { in: unitIds } }, select: { id: true } })
  const allLeaseIds = [...new Set([...leaseIds, ...strayLeases.map((l) => l.id)])]
  await prisma.task.deleteMany({ where: { subjectId: { in: allLeaseIds } } })
  await prisma.leaseTenant.deleteMany({ where: { leaseId: { in: allLeaseIds } } })
  await prisma.leasePayer.deleteMany({ where: { leaseId: { in: allLeaseIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: allLeaseIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })
  await prisma.jurisdictionRule.deleteMany({ where: { id: { in: ruleIds } } })
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.$disconnect()
})

test.describe('renewals', () => {
  test('a PM offers a renewal within the statutory cap and it lands as a linked successor lease', async ({
    page,
  }) => {
    await seedJurisdictionRule({
      state: STATE_UNDER_CAP,
      rentIncreaseCapPercentBps: 1000,
      rentIncreaseNoticeDays: null,
    })
    const { lease } = await seedRunningLease({ state: STATE_UNDER_CAP })
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/leases/${lease.id}`)
    await page.getByRole('heading', { name: 'Renewal', exact: true }).scrollIntoViewIfNeeded()
    await page.getByLabel('New start date').fill('2027-01-01')
    await page.getByLabel('New end date').fill('2027-12-31')
    await page.getByLabel('Proposed rent ($/mo)').fill('1600') // ~6.7% - inside the 10% cap
    await page.getByRole('button', { name: 'Create renewal offer' }).click()

    // NOT the bare /\/leases\/(?!new$)[a-z0-9]+$/ pattern - the page we
    // started ON already matches it, so waitForURL resolves instantly
    // against the PREDECESSOR's own url, before the redirect to the new
    // successor lease even happens (fixtures.ts's own documented trap, hit
    // here in a new spot: excluding "new" is not enough when the starting
    // url is itself a live match).
    await page.waitForURL(
      new RegExp(`/leases/(?!new$)(?!${lease.id}$)[a-z0-9]+$`),
    )
    const successorId = new URL(page.url()).pathname.split('/').pop()!
    leaseIds.push(successorId)

    const successor = await prisma.lease.findUniqueOrThrow({ where: { id: successorId } })
    expect(successor.status).toBe('DRAFT')
    expect(successor.origin).toBe('RENEWAL')
    expect(successor.renewedFromLeaseId).toBe(lease.id)
    expect(successor.rentCents).toBe(160_000)

    await expect(page.getByText('Renewed from')).toBeVisible()
  })

  test('a rent increase over the statutory cap is blocked, with no successor lease created', async ({
    page,
  }) => {
    await seedJurisdictionRule({
      state: STATE_OVER_CAP,
      rentIncreaseCapPercentBps: 500,
      rentIncreaseNoticeDays: null,
    })
    const { lease } = await seedRunningLease({ state: STATE_OVER_CAP })
    const staff = await createStaff()
    await signIn(page, staff.email)

    await page.goto(`/leases/${lease.id}`)
    await page.getByLabel('New start date').fill('2027-01-01')
    await page.getByLabel('New end date').fill('2027-12-31')
    await page.getByLabel('Proposed rent ($/mo)').fill('1800') // 20% - over the 5% cap
    await page.getByRole('button', { name: 'Create renewal offer' }).click()

    await expect(page.getByText(/exceeds the.*statutory cap/)).toBeVisible()
    await expect(page.getByText(/most this may legally increase to/)).toBeVisible()

    const successor = await prisma.lease.findFirst({ where: { renewedFromLeaseId: lease.id } })
    expect(successor).toBeNull()
  })
})
