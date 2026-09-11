import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'
import { Secret, TOTP } from 'otpauth'
import { axeScan, uniqueClientHeaders } from './fixtures.ts'

// The per-entity settlement report (review finding 12, R-180).
//
// The arithmetic is unit-tested in packages/core/payments/settlement.test.ts.
// What only a real request can prove is the part that has nothing to do with
// arithmetic: WHICH ROWS the report is entitled to count. `Payment.channel`
// cannot answer that - the webhook writes `OTHER` for every invoice-driven
// payment - so this file seeds an offline check beside an online payment and
// asserts the check is absent, which is the defect the whole item exists to
// avoid: a check never entered the Stripe balance and will never appear in
// the bank line this report is compared against.

const PASSWORD = 'correct-horse-battery-staple'
const WINDOW = { from: '2026-03-01', to: '2026-03-31' }

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []

async function createStaff() {
  const email = `settlement-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Settlement Test',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return { ...staff, email }
}

/// An owner with an enrolled second factor. Recording a transfer is
/// `ledger.adjust`, which is privileged (ROLE-05), so `createStaff`'s owner is
/// sent to enrol instead of reaching the write.
async function createOwnerWithMfa() {
  const email = `settlement-mfa-${randomUUID()}@example.test`
  const { secret } = createTotpEnrolment(email)
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Settlement Owner',
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          mfaSecret: sealSecret(secret),
          mfaEnrolledAt: new Date(),
        },
      },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return { email, secret }
}

async function seedEntity(label: string) {
  const entity = await prisma.legalEntity.create({
    data: { name: `${label} LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  return entity
}

/// One house with one occupied unit and one live tenancy, ready to be paid
/// against. `America/Chicago` throughout, so every business date in the
/// assertions is read in a zone that is genuinely behind UTC - which is where
/// R-042's class of bug shows up if it ever comes back.
async function seedHouse(legalEntityId: string, name: string) {
  const stamp = randomUUID().slice(0, 8)
  const property = await prisma.property.create({
    data: {
      legalEntityId,
      name: `${name}-${stamp}`,
      addressLine1: '9 Settlement Row',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
      acquiredOn: new Date('2019-01-01T00:00:00Z'),
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: {
      firstName: 'Settle',
      lastName: `Payer-${stamp}`,
      email: `settle-${stamp}@example.test`,
    },
  })
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      startsOn: new Date('2024-01-01T00:00:00Z'),
      rentCents: 150_000,
      rentDueDay: 1,
      status: 'ACTIVE',
      moveInAt: new Date('2024-01-01T17:00:00Z'),
    },
  })
  const payer = await prisma.leasePayer.create({
    data: {
      leaseId: lease.id,
      propertyId: property.id,
      payerType: 'TENANT',
      tenantId: tenant.id,
    },
  })
  return { property, unit, lease, payer, tenant, stamp }
}

/// An ONLINE payment - `receivedByStaffId` null, which is exactly how the
/// webhook writes one and the only marker that separates it from money a
/// human took at the counter.
async function seedOnlinePayment(
  house: { property: { id: string }; lease: { id: string }; payer: { id: string } },
  input: {
    amountCents: number
    receivedAt: string
    status?: 'SETTLED' | 'REVERSED' | 'REFUNDED'
    reversedAt?: string | null
    channel?: 'ACH' | 'CARD' | 'OTHER'
  },
) {
  return prisma.payment.create({
    data: {
      propertyId: house.property.id,
      leaseId: house.lease.id,
      leasePayerId: house.payer.id,
      channel: input.channel ?? 'OTHER',
      status: input.status ?? 'SETTLED',
      amountCents: input.amountCents,
      receivedAt: new Date(input.receivedAt),
      reversedAt: input.reversedAt ? new Date(input.reversedAt) : null,
      stripePaymentIntentId: `pi_settlement_${randomUUID().slice(0, 12)}`,
    },
  })
}

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(uniqueClientHeaders())
})

// BY OWNERSHIP, NOT BY A COLLECTED-ID LIST (CLAUDE.md). Every operational row
// this file writes carries a `propertyId`, so a test that dies halfway
// through still has its debris removed - and the property is deactivated
// rather than deleted, which is the marker `notifications.test.ts` reads as
// "this spec has finished".
test.afterAll(async () => {
  await prisma.payment.deleteMany({ where: { propertyId: { in: propertyIds } } })
  // The tenants are found THROUGH the rows that carry a propertyId rather
  // than from a list this file pushed to - a `Tenant` has no property of its
  // own, so ownership has to be read back off its payer row before that row
  // goes.
  const payers = await prisma.leasePayer.findMany({
    where: { propertyId: { in: propertyIds } },
    select: { tenantId: true },
  })
  const tenantIds = payers.map((row) => row.tenantId).filter((id): id is string => id !== null)
  await prisma.leasePayer.deleteMany({ where: { propertyId: { in: propertyIds } } })
  const leases = await prisma.lease.findMany({
    where: { propertyId: { in: propertyIds } },
    select: { id: true, unitId: true },
  })
  await prisma.lease.deleteMany({ where: { propertyId: { in: propertyIds } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: leases.map((row) => row.unitId) } } })
  await prisma.property.updateMany({
    where: { id: { in: propertyIds } },
    data: { active: false },
  })

  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  const auditedStaff = new Set(
    (
      await prisma.auditLog.findMany({
        where: { actorStaffId: { in: staffIds } },
        select: { actorStaffId: true },
      })
    ).map((row) => row.actorStaffId!),
  )
  await prisma.staffCredential.deleteMany({
    where: { staffUserId: { in: staffIds.filter((id) => !auditedStaff.has(id)) } },
  })
  await prisma.staffUser.deleteMany({
    where: { id: { in: staffIds.filter((id) => !auditedStaff.has(id)) } },
  })
  await prisma.staffUser.updateMany({ where: { id: { in: [...auditedStaff] } }, data: { active: false } })
  await prisma.$disconnect()
})

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

async function signInWithMfa(
  page: import('@playwright/test').Page,
  staff: { email: string; secret: string },
) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(staff.email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/login\/mfa/)
  await page.getByLabel(/code/i).fill(new TOTP({ secret: Secret.fromBase32(staff.secret) }).generate())
  await page.getByRole('button', { name: 'Verify' }).click()
  await page.waitForURL('**/dashboard')
}

async function openReport(page: import('@playwright/test').Page) {
  await page.goto(`/reports/settlement?from=${WINDOW.from}&to=${WINDOW.to}`)
}

test.describe('whose money is in the shared account', () => {
  test('separates two LLCs and adds their shares back up to the bank line', async ({ page }) => {
    const alpha = await seedEntity('Alpha')
    const beta = await seedEntity('Beta')
    const alphaHouse = await seedHouse(alpha.id, 'Alpha House')
    const betaHouse = await seedHouse(beta.id, 'Beta House')

    await seedOnlinePayment(alphaHouse, { amountCents: 150_000, receivedAt: '2026-03-05T15:00:00Z' })
    await seedOnlinePayment(betaHouse, { amountCents: 90_000, receivedAt: '2026-03-07T15:00:00Z' })

    const staff = await createStaff()
    await signIn(page, staff.email)
    await openReport(page)

    const alphaCard = page.getByRole('listitem').filter({ hasText: alpha.name })
    await expect(alphaCard.getByText('$1,500.00').first()).toBeVisible()
    const betaCard = page.getByRole('listitem').filter({ hasText: beta.name })
    await expect(betaCard.getByText('$900.00').first()).toBeVisible()

    // Alpha's money must not appear under Beta. That is the whole finding.
    await expect(betaCard.getByText('$1,500.00')).toHaveCount(0)
  })

  test('leaves out a check, which never entered the Stripe balance', async ({ page }) => {
    const entity = await seedEntity('Mixed')
    const house = await seedHouse(entity.id, 'Mixed House')

    await seedOnlinePayment(house, { amountCents: 120_000, receivedAt: '2026-03-11T15:00:00Z' })

    // The counter check. `receivedByStaffId` is what `recordOfflinePayment`
    // sets and what the report keys on; note the channel says OFFLINE_CHECK
    // while the ONLINE row above says OTHER, so a channel-based filter would
    // have got this exactly backwards.
    const staff = await createStaff()
    await prisma.payment.create({
      data: {
        propertyId: house.property.id,
        leaseId: house.lease.id,
        leasePayerId: house.payer.id,
        channel: 'OFFLINE_CHECK',
        status: 'SETTLED',
        amountCents: 75_000,
        receivedAt: new Date('2026-03-12T12:00:00Z'),
        receivedByStaffId: staff.id,
        checkNumber: '4471',
      },
    })

    await signIn(page, staff.email)
    await openReport(page)

    const card = page.getByRole('listitem').filter({ hasText: entity.name })
    await expect(card.getByText('$1,200.00').first()).toBeVisible()
    await expect(card.getByText('$750.00')).toHaveCount(0)
    // $1,950 is what this entity would be owed if the check had been counted.
    await expect(card.getByText('$1,950.00')).toHaveCount(0)
  })
})

test.describe('a payment that came back', () => {
  test('is subtracted from the month it was returned in, not the one that earned it', async ({
    page,
  }) => {
    const entity = await seedEntity('Returned')
    const house = await seedHouse(entity.id, 'Returned House')

    await seedOnlinePayment(house, {
      amountCents: 150_000,
      receivedAt: '2026-03-09T15:00:00Z',
      status: 'REVERSED',
      reversedAt: '2026-04-02T15:00:00Z',
    })

    const staff = await createStaff()
    await signIn(page, staff.email)

    // ASSERTED ON THIS ENTITY'S CARD, NOT ON THE PORTFOLIO TOTAL. The total
    // region sums every entity in scope, and `rental_test` is shared - any
    // other spec that settles an online payment in the same month makes an
    // assertion on that figure red. It cost this file one flaky run before it
    // was written down.
    await openReport(page)
    const march = page.getByRole('listitem').filter({ hasText: entity.name })
    await expect(march.getByText('$1,500.00').first()).toBeVisible()

    // April is short by exactly that, with nothing settled in it.
    await page.goto('/reports/settlement?from=2026-04-01&to=2026-04-30')
    const april = page.getByRole('listitem').filter({ hasText: entity.name })
    // Twice over, and both are right: the entity's own net and the one house
    // behind it. `.first()` takes the entity line, which is the transfer
    // figure the owner acts on.
    await expect(april.getByText('-$1,500.00').first()).toBeVisible()
  })
})

test.describe('the export', () => {
  test('downloads the payment rows a bookkeeper matches against a statement', async ({ page }) => {
    const entity = await seedEntity('Export')
    const house = await seedHouse(entity.id, 'Export House')
    await seedOnlinePayment(house, { amountCents: 133_000, receivedAt: '2026-03-14T15:00:00Z' })

    const staff = await createStaff()
    await signIn(page, staff.email)

    const response = await page.request.get(
      `/api/reports/settlement?from=${WINDOW.from}&to=${WINDOW.to}`,
    )
    expect(response.status()).toBe(200)
    expect(response.headers()['content-disposition']).toContain('settlement-2026-03-01-to-2026-03-31.csv')

    const csv = await response.text()
    expect(csv).toContain('Settled on,Legal entity,Property,Unit,Payer,Channel,Amount,Returned on')
    // A bare number a spreadsheet can sum, and the property-local day - the
    // payment is 15:00 UTC, which is 10:00 in Houston and the same date; a
    // 23:00 UTC one would not be, which is what the zone reader is for.
    expect(csv).toContain('2026-03-14')
    expect(csv).toContain('1330.00')
    expect(csv).toContain(house.property.name)
  })
})

test.describe('recording the sweep (R-198)', () => {
  test('records what moved and archives the report it was computed from', async ({ page }) => {
    const entity = await seedEntity('Sweep')
    const house = await seedHouse(entity.id, 'Sweep House')
    await seedOnlinePayment(house, { amountCents: 150_000, receivedAt: '2026-03-20T15:00:00Z' })

    const owner = await createOwnerWithMfa()
    await signInWithMfa(page, owner)
    await openReport(page)

    const card = page.getByRole('listitem').filter({ hasText: entity.name })
    const amount = card.getByLabel(`Amount moved to ${entity.name}`)
    const movedOn = card.getByLabel(`Day the money was moved to ${entity.name}`)
    const reference = card.getByLabel(`Bank confirmation for ${entity.name}`)
    const record = card.getByRole('button', { name: `Record the transfer to ${entity.name}` })

    // More than the report says the entity is owed is not a settlement. The
    // figure is recomputed server-side, so this is the action refusing, not
    // the browser.
    await amount.fill('1500.01')
    await movedOn.fill('2026-04-04')
    await reference.fill('TRF-too-much')
    await record.click()
    await expect(card.getByText('More than the $1,500.00 this entity is owed for the range.')).toBeVisible()
    expect(await prisma.entitySettlement.count({ where: { legalEntityId: entity.id } })).toBe(0)

    // Short of the gross by the fees, which is the ordinary case.
    const trace = `TRF-${randomUUID().slice(0, 8)}`
    await amount.fill('1455.25')
    await movedOn.fill('2026-04-04')
    await reference.fill(trace)
    await record.click()

    await expect
      .poll(() => prisma.entitySettlement.count({ where: { legalEntityId: entity.id } }))
      .toBe(1)
    const row = await prisma.entitySettlement.findFirstOrThrow({
      where: { legalEntityId: entity.id },
      include: { document: true },
    })
    expect(row).toMatchObject({ grossCents: 150_000, transferredCents: 145_525, reference: trace })
    expect(row.document).toMatchObject({ type: 'SETTLEMENT_REPORT', legalEntityId: entity.id })
    expect(
      await prisma.auditLog.count({
        where: { action: 'settlement.transfer_recorded', entityId: row.id },
      }),
    ).toBe(1)

    // The record stands where the form was, and the archive is a real PDF.
    await expect(card.getByText(/Transferred \$1,455\.25 on 4 Apr 2026/)).toBeVisible()
    await expect(record).toHaveCount(0)
    const link = card.getByRole('link', { name: /Open the archived report/ })
    const response = await page.request.get((await link.getAttribute('href'))!)
    expect(response.status()).toBe(200)
    expect((await response.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-')

    // A range overlapping the recorded one offers no second transfer - that
    // would move the 20 March rent twice.
    await page.goto('/reports/settlement?from=2026-03-15&to=2026-04-15')
    const overlapping = page.getByRole('listitem').filter({ hasText: entity.name })
    await expect(overlapping.getByText(/Transferred \$1,455\.25 on 4 Apr 2026/)).toBeVisible()
    await expect(overlapping.getByRole('button', { name: /Record the transfer/ })).toHaveCount(0)
  })
})

test.describe('accessibility', () => {
  test('the report has no axe violations', async ({ page }) => {
    const entity = await seedEntity('Axe')
    const house = await seedHouse(entity.id, 'Axe House')
    await seedOnlinePayment(house, { amountCents: 101_000, receivedAt: '2026-03-18T15:00:00Z' })

    const staff = await createStaff()
    await signIn(page, staff.email)
    await openReport(page)
    await expect(page.getByRole('heading', { name: 'Settlement by entity' })).toBeVisible()

    const results = await axeScan(page)
    expect(results.violations).toEqual([])
  })
})
