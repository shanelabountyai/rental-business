import { randomUUID } from 'node:crypto'
import { createTotpEnrolment, hashPassword, sealSecret } from '@rental/core/auth'
import { Secret, TOTP } from 'otpauth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// Eviction case files (PAY-14, R-083).
//
// The load-bearing assertion in this file is the FILING GATE: the product
// refuses to record a filing while the cure period is still running, and
// refuses outright when every recorded service used a method the state does
// not name. Those two are the mistakes that get a case dismissed and the
// whole thing started over, and they are the reason this item exists.

const PASSWORD = 'correct-horse-battery-staple'

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const tenantIds: string[] = []
const caseIds: string[] = []

async function seedOwner() {
  const staff = await prisma.staffUser.create({
    data: {
      email: `evict-${randomUUID()}@example.test`,
      name: 'Eviction Test Owner',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return staff
}

/// A Texas property, because Texas is the seeded jurisdiction and its
/// `payOrQuitDays` is 3 - the number the cure clock in these tests runs on.
async function seedTenancy() {
  const stamp = randomUUID().slice(0, 8)
  const entity = await prisma.legalEntity.create({ data: { name: `Evict LLC-${stamp}`, type: 'LLC' } })
  entityIds.push(entity.id)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entity.id,
      name: `Evict House-${stamp}`,
      addressLine1: '4 Courthouse Way',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyIds.push(property.id)
  const unit = await prisma.unit.create({
    data: { propertyId: property.id, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Evict', lastName: `Tenant-${stamp}` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId: property.id,
      unitId: unit.id,
      status: 'ACTIVE',
      startsOn: new Date('2026-01-01'),
      rentCents: 150_000,
    },
  })
  await prisma.leaseTenant.create({ data: { leaseId: lease.id, tenantId: tenant.id } })
  return { property, unit, lease, stamp }
}

/// A served pay-or-quit notice. `permitted` is R-051's own stored verdict
/// (`permittedByJurisdiction`) - the fact this whole item consumes rather
/// than recomputes.
async function seedServedNotice(
  args: {
    propertyId: string
    leaseId: string
    servedAt: Date
    permitted: boolean | null
    type?: string
  },
) {
  const notice = await prisma.notice.create({
    data: {
      propertyId: args.propertyId,
      leaseId: args.leaseId,
      type: args.type ?? 'PAY_OR_QUIT',
      addressOfRecord: '4 Courthouse Way, Houston, TX 77002',
      serviceMethod: 'PERSONAL',
      servedAt: args.servedAt,
    },
  })
  await prisma.noticeDelivery.create({
    data: {
      noticeId: notice.id,
      method: args.permitted === false ? 'EMAIL' : 'PERSONAL',
      servedAt: args.servedAt,
      permittedByJurisdiction: args.permitted,
    },
  })
  return notice
}

// Login is rate-limited per IP, and every test here signs in - without a
// distinct forwarded-for the later ones are throttled and fail at
// waitForURL('**/dashboard'), which reads as a broken page rather than a
// throttle. Same guard every other signing-in spec in this suite uses.
test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

async function openCaseFor(leaseId: string, staffId: string, propertyId: string, unitId: string) {
  const created = await prisma.evictionCase.create({
    data: { propertyId, unitId, leaseId, openedByStaffId: staffId, notes: 'Rent unpaid since March.' },
  })
  caseIds.push(created.id)
  return created
}

test.afterAll(async () => {
  // NoticeDelivery is append-only by trigger and RESTRICTs everything it
  // points at, so notices, cases, leases and properties all STAY - only the
  // roots are retired. The same pattern e2e/notices.spec.ts had to adopt for
  // the same reason, and the one CLAUDE.md names: cleanup cannot delete a row
  // an append-only table references.
  await prisma.staffAssignment.deleteMany({ where: { staffUserId: { in: staffIds } } })
  await prisma.staffUser.updateMany({ where: { id: { in: staffIds } }, data: { active: false } })
  await prisma.lease.updateMany({ where: { propertyId: { in: propertyIds } }, data: { status: 'ENDED' } })
  await prisma.tenant.updateMany({ where: { id: { in: tenantIds } }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: { in: propertyIds } }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: { in: entityIds } }, data: { active: false } })
  await prisma.$disconnect()
})

test('THE GATE: a filing is refused while the cure period is still running', async ({ page }) => {
  const { property, unit, lease } = await seedTenancy()
  const staff = await seedOwner()
  const evictionCase = await openCaseFor(lease.id, staff.id, property.id, unit.id)
  // Served today, so with Texas's three days the tenant still has time.
  const notice = await seedServedNotice({
    propertyId: property.id,
    leaseId: lease.id,
    servedAt: new Date(),
    permitted: true,
  })
  await prisma.notice.update({ where: { id: notice.id }, data: { evictionCaseId: evictionCase.id } })

  await signIn(page, staff.email)
  await page.goto(`/evictions/${evictionCase.id}`)

  await expect(page.getByText(/Cure period running/)).toBeVisible()
  await expect(page.getByText(/cure period has not run out yet/i)).toBeVisible()
  // The control to record a filing is not offered at all while the clock runs.
  await expect(page.getByRole('button', { name: 'Record the filing' })).toHaveCount(0)
})

// D-148. Texas has no separate "pay or quit" to serve: Tex. Prop. Code 24.005
// names the non-payment instrument a NOTICE TO VACATE, and the TX rule models
// its three days as `payOrQuitDays`. The picker offered that type and the cure
// clock counted only PAY_OR_QUIT, so a case holding the notice Texas actually
// uses reported "Notice not yet served" - with the served notice listed on the
// same screen - and could never be filed. Found by the Milestone 10 demo walk,
// on the demo's own eviction case.
test('a Texas notice to vacate runs the cure clock, and is offered to attach', async ({ page }) => {
  const { property, unit, lease } = await seedTenancy()
  const staff = await seedOwner()
  const evictionCase = await openCaseFor(lease.id, staff.id, property.id, unit.id)
  const notice = await seedServedNotice({
    propertyId: property.id,
    leaseId: lease.id,
    servedAt: new Date(),
    permitted: true,
    type: 'NOTICE_TO_VACATE',
  })

  await signIn(page, staff.email)

  // Unattached, it is what the picker offers - the half that used to agree.
  // Counted rather than asserted VISIBLE: it is an <option> inside a closed
  // <select>, which Playwright correctly reports as hidden.
  await page.goto(`/evictions/${evictionCase.id}`)
  await expect(page.locator('option', { hasText: 'Notice to vacate' })).toHaveCount(1)

  await prisma.notice.update({ where: { id: notice.id }, data: { evictionCaseId: evictionCase.id } })
  await page.goto(`/evictions/${evictionCase.id}`)

  // Attached, the clock now runs from it rather than reporting no service.
  await expect(page.getByText(/Cure period running/)).toBeVisible()
  await expect(page.getByText(/Notice not yet served/)).toHaveCount(0)
})

test('THE GATE: defective service runs no clock and blocks filing however long ago it was', async ({ page }) => {
  const { property, unit, lease } = await seedTenancy()
  const staff = await seedOwner()
  const evictionCase = await openCaseFor(lease.id, staff.id, property.id, unit.id)
  // Served years ago, but by a method Texas does not name for a pay-or-quit
  // (R-051 stored that verdict at the time of service).
  const notice = await seedServedNotice({
    propertyId: property.id,
    leaseId: lease.id,
    servedAt: new Date('2020-01-01T12:00:00Z'),
    permitted: false,
  })
  await prisma.notice.update({ where: { id: notice.id }, data: { evictionCaseId: evictionCase.id } })

  await signIn(page, staff.email)
  await page.goto(`/evictions/${evictionCase.id}`)

  await expect(page.getByText(/No cure period is running/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Record the filing' })).toHaveCount(0)

  const unchanged = await prisma.evictionCase.findUniqueOrThrow({ where: { id: evictionCase.id } })
  expect(unchanged.stage).toBe('NOTICE')
  expect(unchanged.filedOn).toBeNull()
})

test('a case whose cure period expired records a filing, a cost, and produces a packet', async ({ page }) => {
  const { property, unit, lease } = await seedTenancy()
  const staff = await seedOwner()
  const evictionCase = await openCaseFor(lease.id, staff.id, property.id, unit.id)
  const notice = await seedServedNotice({
    propertyId: property.id,
    leaseId: lease.id,
    servedAt: new Date('2026-01-05T12:00:00Z'),
    permitted: true,
  })
  await prisma.notice.update({ where: { id: notice.id }, data: { evictionCaseId: evictionCase.id } })

  await signIn(page, staff.email)
  await page.goto(`/evictions/${evictionCase.id}`)

  await expect(page.getByText(/Cure period expired/)).toBeVisible()

  await page.locator('#field-advance-stageDate').fill('2026-01-20')
  await page.getByRole('button', { name: 'Record the filing' }).click()
  await expect(page.getByText('Stage recorded.')).toBeVisible()

  const filed = await prisma.evictionCase.findUniqueOrThrow({ where: { id: evictionCase.id } })
  expect(filed.stage).toBe('FILING')
  expect(filed.filedOn).not.toBeNull()

  // A cost the owner actually paid - not a ledger entry, not a tenant charge.
  await page.locator('#field-cost-type').selectOption({ value: 'FILING' })
  await page.locator('#field-cost-amountDollars').fill('121.00')
  await page.locator('#field-cost-incurredOn').fill('2026-01-20')
  await page.locator('#field-cost-description').fill('Harris County JP filing fee')
  await page.getByRole('button', { name: 'Record cost' }).click()
  await expect(page.getByText('Cost recorded.')).toBeVisible()

  const costs = await prisma.evictionCost.findMany({ where: { evictionCaseId: evictionCase.id } })
  expect(costs).toHaveLength(1)
  expect(costs[0]!.amountCents).toBe(12_100)
  // It must NEVER have become a ledger entry - that table is a Stripe
  // projection (D-11) and a court filing fee is money Stripe never saw.
  const ledgerLeak = await prisma.ledgerEntry.count({
    where: { leaseId: lease.id, amountCents: 12_100 },
  })
  expect(ledgerLeak).toBe(0)

  // One click, one file.
  await page.getByRole('button', { name: 'Produce attorney packet' }).click()
  await expect(page.getByText(/Packet produced/)).toBeVisible()

  const packet = await prisma.document.findFirstOrThrow({
    where: { leaseId: lease.id, type: 'ATTORNEY_PACKET' },
  })
  expect(packet.contentType).toBe('application/pdf')
  expect(packet.sizeBytes).toBeGreaterThan(0)
  // Never linked to the tenant: a packet assembled for a case AGAINST them
  // must not appear in their own portal (R-052's own call, reused).
  expect(packet.tenantId).toBeNull()

  const audited = await prisma.auditLog.findFirst({
    where: { action: 'eviction.packet_exported', entityId: evictionCase.id },
  })
  expect(audited).not.toBeNull()
})

test('a case closes with cash for keys, and the outcome is on the record', async ({ page }) => {
  const { property, unit, lease } = await seedTenancy()
  const staff = await seedOwner()
  const evictionCase = await openCaseFor(lease.id, staff.id, property.id, unit.id)

  await signIn(page, staff.email)
  await page.goto(`/evictions/${evictionCase.id}`)

  await page.locator('#field-close-outcome').selectOption({ value: 'CASH_FOR_KEYS' })
  await page.locator('#field-close-outcomeNote').fill('Agreed $1,200 and keys returned 30 April.')
  await page.getByRole('button', { name: 'Close case' }).click()
  // NOT the action's 'Case closed.' notice - closing removes the section that
  // panel lives in, so the live region is unmounted in the same pass that
  // would have filled it (see closeCase's own comment). What the user
  // actually sees, and what this asserts, is the outcome on the page.
  await expect(page.getByText(/Cash for keys — agreed move-out/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close case' })).toHaveCount(0)

  const closed = await prisma.evictionCase.findUniqueOrThrow({ where: { id: evictionCase.id } })
  expect(closed.stage).toBe('CLOSED')
  expect(closed.outcome).toBe('CASH_FOR_KEYS')
  expect(closed.closedAt).not.toBeNull()

  // REASON_REQUIRED: the terms reach the permanent audit row, not just a
  // column somebody could later edit.
  const audited = await prisma.auditLog.findFirstOrThrow({
    where: { action: 'eviction.case_closed', entityId: evictionCase.id },
  })
  expect(audited.reason).toContain('1,200')
})

// R-156. Money arriving now connects to the notice and the case: the case
// page names any payment accepted after service, and serving a cure-starting
// notice offers the hold in the same press.

async function seedPayer(leaseId: string, propertyId: string, tenantId: string) {
  return prisma.leasePayer.create({
    data: {
      leaseId,
      propertyId,
      payerType: 'TENANT',
      tenantId,
      collectionMethod: 'send_invoice',
      stripeCustomerId: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
    },
  })
}

test('a payment accepted after service shows as a red band on the case, and pre-service money does not', async ({ page }) => {
  const { property, unit, lease, stamp } = await seedTenancy()
  const staff = await seedOwner()
  const evictionCase = await openCaseFor(lease.id, staff.id, property.id, unit.id)
  const servedAt = new Date('2026-08-20T15:00:00Z')
  const notice = await seedServedNotice({
    propertyId: property.id,
    leaseId: lease.id,
    servedAt,
    permitted: true,
  })
  await prisma.notice.update({ where: { id: notice.id }, data: { evictionCaseId: evictionCase.id } })

  const tenant = await prisma.tenant.findFirstOrThrow({ where: { lastName: `Tenant-${stamp}` } })
  const payer = await seedPayer(lease.id, property.id, tenant.id)
  // One before service, one after - only the second may appear. Distinct
  // amounts so the assertion cannot match the wrong row.
  await prisma.payment.createMany({
    data: [
      {
        propertyId: property.id,
        leaseId: lease.id,
        leasePayerId: payer.id,
        channel: 'OFFLINE_CASH',
        status: 'SETTLED',
        amountCents: 12_345,
        receivedAt: new Date('2026-08-01T12:00:00Z'),
      },
      {
        propertyId: property.id,
        leaseId: lease.id,
        leasePayerId: payer.id,
        channel: 'OFFLINE_CASH',
        status: 'SETTLED',
        amountCents: 40_000,
        receivedAt: new Date('2026-08-25T12:00:00Z'),
      },
    ],
  })

  await signIn(page, staff.email)
  await page.goto(`/evictions/${evictionCase.id}`)

  await expect(page.getByRole('heading', { name: 'Money accepted after service' })).toBeVisible()
  await expect(page.getByText('$400.00 — Cash at the counter, 25 Aug 2026')).toBeVisible()
  // Texas's seeded rule has no acceptance stance on file, so the warning is
  // the conservative one - never an answer the state did not give.
  await expect(page.getByText(/state law this product has not been taught/)).toBeVisible()
  await expect(page.getByText('$123.45')).toHaveCount(0)
})

test('serving a pay-or-quit places the hold in the same press, and proves it reached the payer row', async ({ page }) => {
  const { property, unit, lease, stamp } = await seedTenancy()
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { lastName: `Tenant-${stamp}` } })
  const payer = await seedPayer(lease.id, property.id, tenant.id)

  // MFA ENROLLED, because placing a hold is `ledger.adjust` and R-004
  // requires a verified second factor for it - without one the offer does
  // not render at all, which is the product working (fee-waiver.spec.ts
  // documents the same trap).
  const email = `evict-hold-${randomUUID()}@example.test`
  const { secret } = createTotpEnrolment(email)
  const holder = await prisma.staffUser.create({
    data: {
      email,
      name: 'Serve And Hold Owner',
      credential: {
        create: {
          passwordHash: await hashPassword(PASSWORD),
          mfaSecret: sealSecret(secret),
          mfaEnrolledAt: new Date(),
        },
      },
    },
  })
  staffIds.push(holder.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: holder.id, roleId: role.id } })
  const evictionCase = await openCaseFor(lease.id, holder.id, property.id, unit.id)

  const notice = await prisma.notice.create({
    data: {
      propertyId: property.id,
      leaseId: lease.id,
      evictionCaseId: evictionCase.id,
      type: 'NOTICE_TO_VACATE',
      addressOfRecord: '4 Courthouse Way, Houston, TX 77002',
    },
  })

  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/login\/mfa/)
  await page.getByLabel(/code/i).fill(new TOTP({ secret: Secret.fromBase32(secret) }).generate())
  await page.getByRole('button', { name: 'Verify' }).click()
  await page.waitForURL('**/dashboard')

  await page.goto(`/notices/${notice.id}`)
  // The offer arrives pre-set: the safe path is the one-press path and
  // opting out is the deliberate act.
  await expect(
    page.getByLabel('Also place a payment hold when this service is recorded'),
  ).toBeChecked()
  await page.getByLabel('When was it served?').fill('2026-08-30T10:00')
  await page.getByRole('button', { name: 'Serve and hold' }).click()

  await expect(page.getByText(/payment hold is in force/)).toBeVisible()
  // The row the pay screen, the pay-link page and the counter all read.
  const held = await prisma.leasePayer.findUniqueOrThrow({ where: { id: payer.id } })
  expect(held.collectionPaused).toBe(true)
  expect(held.blockPartialPayments).toBe(true)
  expect(held.certifiedFundsOnly).toBe(true)
  expect(held.paymentHoldReason).toContain('served')
  expect(held.paymentHoldSetByStaffId).toBe(holder.id)
})
