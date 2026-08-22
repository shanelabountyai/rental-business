import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import { hashPassword } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { expect, test } from '@playwright/test'

// The year-end tax packet (RPT-07, R-081b).
//
// The arithmetic is unit-tested in packages/core/tax/packet.test.ts. What
// this file proves is what only a real request can: that Schedule E splits by
// property, that a 1098 recorded against a loan reaches line 12, that the
// deposit schedule is a balance rather than a period flow, and that card
// payments are kept off the 1099-NEC figure.

const PASSWORD = 'correct-horse-battery-staple'
const YEAR = 2026

const staffIds: string[] = []
const entityIds: string[] = []
const propertyIds: string[] = []
const unitIds: string[] = []
const leaseIds: string[] = []
const tenantIds: string[] = []
const vendorIds: string[] = []
const workOrderIds: string[] = []
const depositIds: string[] = []
const mortgageIds: string[] = []

async function createStaff() {
  const email = `packet-${randomUUID()}@example.test`
  const staff = await prisma.staffUser.create({
    data: {
      email,
      name: 'Tax Packet Test',
      credential: { create: { passwordHash: await hashPassword(PASSWORD) } },
    },
  })
  staffIds.push(staff.id)
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'owner' } })
  await prisma.staffAssignment.create({ data: { staffUserId: staff.id, roleId: role.id } })
  return { ...staff, email }
}

async function seedEntity(label: string) {
  const entity = await prisma.legalEntity.create({
    data: { name: `${label} LLC-${randomUUID().slice(0, 8)}`, type: 'LLC' },
  })
  entityIds.push(entity.id)
  return entity
}

async function seedProperty(entityId: string, name: string) {
  const stamp = randomUUID().slice(0, 8)
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: `${name}-${stamp}`,
      addressLine1: '1 Packet Way',
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
  unitIds.push(unit.id)
  return { property, unit, stamp }
}

async function seedLease(propertyId: string, unitId: string, stamp: string) {
  const tenant = await prisma.tenant.create({
    data: { firstName: 'Pack', lastName: `Test-${stamp}`, email: `pack-${stamp}@example.test` },
  })
  tenantIds.push(tenant.id)
  const lease = await prisma.lease.create({
    data: {
      propertyId,
      unitId,
      startsOn: new Date('2024-01-01T00:00:00Z'),
      rentCents: 145_000,
      rentDueDay: 1,
      status: 'ACTIVE',
      moveInAt: new Date('2024-01-01T17:00:00Z'),
    },
  })
  leaseIds.push(lease.id)
  return lease
}

async function seedPaidJob(
  propertyId: string,
  unitId: string,
  vendorId: string,
  invoiceCents: number,
  method: string,
) {
  const job = await prisma.workOrder.create({
    data: {
      propertyId,
      unitId,
      vendorId,
      scope: `Job ${randomUUID().slice(0, 6)}`,
      status: 'CLOSED',
      invoiceCents,
      closedAt: new Date(`${YEAR}-04-02T15:00:00Z`),
      invoicePaidAt: new Date(`${YEAR}-04-09T15:00:00Z`),
      invoicePaymentMethod: method,
    },
  })
  workOrderIds.push(job.id)
  return job
}

test.beforeEach(async ({ page }) => {
  const octet = () => Math.floor(Math.random() * 254) + 1
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}` })
})

test.afterAll(async () => {
  // The archived packets first: nothing append-only references them, and
  // leaving them behind would orphan rows against entities this teardown is
  // about to remove.
  await prisma.document.deleteMany({
    where: { type: 'TAX_PACKET', legalEntityId: { in: entityIds } },
  })
  await prisma.mortgageAnnualStatement.deleteMany({
    where: { mortgage: { propertyId: { in: propertyIds } } },
  })
  await prisma.mortgage.deleteMany({ where: { id: { in: mortgageIds } } })
  await prisma.deposit.deleteMany({ where: { id: { in: depositIds } } })
  await prisma.workOrder.deleteMany({ where: { id: { in: workOrderIds } } })
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } })
  await prisma.lease.deleteMany({ where: { id: { in: leaseIds } } })
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
  await prisma.unit.deleteMany({ where: { id: { in: unitIds } } })

  const auditedProperties = new Set(
    (
      await prisma.auditLog.findMany({
        where: { propertyId: { in: propertyIds } },
        select: { propertyId: true },
      })
    ).map((row) => row.propertyId!),
  )
  await prisma.property.deleteMany({
    where: { id: { in: propertyIds.filter((id) => !auditedProperties.has(id)) } },
  })
  await prisma.property.updateMany({
    where: { id: { in: [...auditedProperties] } },
    data: { active: false },
  })
  const stillReferenced = new Set(
    (
      await prisma.property.findMany({
        where: { legalEntityId: { in: entityIds } },
        select: { legalEntityId: true },
      })
    ).map((row) => row.legalEntityId),
  )
  await prisma.legalEntity.deleteMany({
    where: { id: { in: entityIds.filter((id) => !stillReferenced.has(id)) } },
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
  await prisma.staffUser.updateMany({
    where: { id: { in: [...auditedStaff] } },
    data: { active: false },
  })
  await prisma.$disconnect()
})

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard')
}

test.describe('Schedule E per property', () => {
  test('splits one entity onto its addresses and books a 1098 to line 12', async ({ page }) => {
    const entity = await seedEntity('Packet')
    const one = await seedProperty(entity.id, 'First House')
    const two = await seedProperty(entity.id, 'Second House')
    const staff = await createStaff()

    const vendor = await prisma.vendor.create({
      data: { name: `Plumber-${randomUUID().slice(0, 6)}`, trades: ['plumbing'], w9OnFile: true },
    })
    vendorIds.push(vendor.id)
    await seedPaidJob(one.property.id, one.unit.id, vendor.id, 26_000, 'CHECK')

    const mortgage = await prisma.mortgage.create({
      data: { propertyId: two.property.id, lender: 'First National', rateType: 'FIXED', isBalloon: false },
    })
    mortgageIds.push(mortgage.id)
    await prisma.mortgageAnnualStatement.create({
      data: {
        mortgageId: mortgage.id,
        taxYear: YEAR,
        interestCents: 1_240_000,
        recordedByStaffId: staff.id,
      },
    })

    await signIn(page, staff.email)
    await page.goto(`/reports/tax-packet?entity=${entity.id}&year=${YEAR}&basis=cash`)

    // The repair sits on the first house, the mortgage interest on the second.
    await expect(page.getByText('Line 14 · Repairs')).toBeVisible()
    // Scoped to the row: with the 1098 as that property's only line, the
    // same figure is legitimately both the line total AND its net.
    const line12 = page.locator('dt', { hasText: 'Line 12 · Mortgage interest paid to banks' })
    await expect(line12).toBeVisible()
    await expect(line12.locator('+ dd')).toHaveText('$12,400.00')

    // Each address gets its own heading - Schedule E is filed per property.
    await expect(page.getByRole('heading', { name: /First House/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: /Second House/ })).toBeVisible()
  })
})

test.describe('deposit liability', () => {
  test('is a balance at year end, not deposits received', async ({ page }) => {
    const entity = await seedEntity('Deposits')
    const { property, unit, stamp } = await seedProperty(entity.id, 'Deposit House')
    const lease = await seedLease(property.id, unit.id, stamp)

    // Disposed of in MARCH OF THE FOLLOWING YEAR, so on 31 December the
    // owner still held all of it. A naive sum would report zero.
    const deposit = await prisma.deposit.create({
      data: {
        propertyId: property.id,
        leaseId: lease.id,
        heldCents: 145_000,
        appliedCents: 45_000,
        refundedCents: 100_000,
        receivedAt: new Date('2024-01-01T12:00:00Z'),
        dispositionSentAt: new Date(`${YEAR + 1}-03-04T12:00:00Z`),
      },
    })
    depositIds.push(deposit.id)

    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/reports/tax-packet?entity=${entity.id}&year=${YEAR}&basis=cash`)

    const deposits = page.getByRole('region', {
      name: `Security deposit liability at 31 December ${YEAR}`,
    })
    // Same again: one property, so the property row and the "Held" total are
    // the same number. Assert the total, which is the claim under test.
    await expect(deposits.locator('dt', { hasText: 'Held' }).locator('+ dd')).toHaveText(
      '$1,450.00',
    )
  })
})

test.describe('1099-NEC candidates', () => {
  test('keeps card payments off the reportable figure', async ({ page }) => {
    const entity = await seedEntity('Vendors')
    const { property, unit } = await seedProperty(entity.id, 'Vendor House')

    const vendor = await prisma.vendor.create({
      data: { name: `Mixed-${randomUUID().slice(0, 6)}`, trades: ['hvac'], w9OnFile: false },
    })
    vendorIds.push(vendor.id)
    // $400 by card + $300 by check. Only the $300 is 1099-NEC reportable, so
    // this vendor is UNDER the $600 threshold despite $700 paid.
    await seedPaidJob(property.id, unit.id, vendor.id, 40_000, 'CARD')
    await seedPaidJob(property.id, unit.id, vendor.id, 30_000, 'CHECK')

    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/reports/tax-packet?entity=${entity.id}&year=${YEAR}&basis=cash`)

    const section = page.getByRole('region', { name: '1099-NEC candidates' })
    await expect(section.getByText('$300.00')).toBeVisible()
    await expect(section.getByText(/by card.*Under the threshold/)).toBeVisible()
    // No W-9, but under the threshold once card comes out, so nothing to chase.
    await expect(page.getByText('with no W-9 on file')).toHaveCount(0)
  })

  test('flags a vendor over the threshold with no W-9', async ({ page }) => {
    const entity = await seedEntity('Chase')
    const { property, unit } = await seedProperty(entity.id, 'Chase House')

    const vendor = await prisma.vendor.create({
      data: { name: `NoW9-${randomUUID().slice(0, 6)}`, trades: ['roofing'], w9OnFile: false },
    })
    vendorIds.push(vendor.id)
    await seedPaidJob(property.id, unit.id, vendor.id, 80_000, 'CHECK')

    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/reports/tax-packet?entity=${entity.id}&year=${YEAR}&basis=cash`)

    await expect(page.getByText(/vendor over the threshold with no W-9 on file/)).toBeVisible()
  })
})

test.describe('the CSV', () => {
  test('carries every schedule in one file', async ({ page }) => {
    const entity = await seedEntity('Csv')
    const { property, unit } = await seedProperty(entity.id, 'Csv House')
    const vendor = await prisma.vendor.create({
      data: { name: `CsvVendor-${randomUUID().slice(0, 6)}`, trades: ['plumbing'], w9OnFile: true },
    })
    vendorIds.push(vendor.id)
    await seedPaidJob(property.id, unit.id, vendor.id, 26_000, 'CHECK')

    const staff = await createStaff()
    await signIn(page, staff.email)

    const response = await page.request.get(
      `/api/reports/tax-packet?entity=${entity.id}&year=${YEAR}&basis=cash`,
    )
    expect(response.status()).toBe(200)
    expect(response.headers()['content-disposition']).toContain('tax-packet-')

    const csv = await response.text()
    expect(csv).toContain('Schedule')
    expect(csv).toContain('SCHEDULE_E')
    expect(csv).toContain('FORM_1099_NEC')
    expect(csv).toContain('260.00')
  })

  test('answers 404 for an entity outside scope, not 403', async ({ page }) => {
    const mine = await seedEntity('Mine')
    await seedProperty(mine.id, 'Mine House')
    const theirs = await seedEntity('Theirs')

    const staff = await createStaff()
    await signIn(page, staff.email)

    // No property belongs to `theirs`, so it resolves to nothing in scope.
    const response = await page.request.get(
      `/api/reports/tax-packet?entity=${theirs.id}&year=${YEAR}&basis=cash`,
    )
    expect(response.status()).toBe(404)
  })
})

test.describe('the archived packet (R-081d)', () => {
  test('produces a downloadable PDF and names the 1098 it could not attach', async ({ page }) => {
    const entity = await seedEntity('Archive')
    const { property } = await seedProperty(entity.id, 'Archive House')
    const staff = await createStaff()

    // A recorded 1098 with NO uploaded form - R-081b's deliberate gap, and
    // exactly the case D-50 says must be named rather than left silent.
    const mortgage = await prisma.mortgage.create({
      data: {
        propertyId: property.id,
        lender: 'Unattached Bank',
        rateType: 'FIXED',
        isBalloon: false,
      },
    })
    mortgageIds.push(mortgage.id)
    await prisma.mortgageAnnualStatement.create({
      data: {
        mortgageId: mortgage.id,
        taxYear: YEAR,
        interestCents: 980_000,
        recordedByStaffId: staff.id,
      },
    })

    await signIn(page, staff.email)
    await page.goto(`/reports/tax-packet?entity=${entity.id}&year=${YEAR}&basis=cash`)

    await page.getByRole('button', { name: 'Archive packet as PDF' }).click()
    await expect(page.getByText(/named on the index but could not be attached/)).toBeVisible()

    // The artifact has to be REACHABLE, which is the whole reason
    // `Document.legalEntityId` exists: before it, a document with no property
    // was refused to every staff member by the file route, including the
    // owner who had just produced it.
    const link = page.getByRole('link', { name: 'Open the archived packet' })
    await expect(link).toBeVisible()
    const href = await link.getAttribute('href')
    const file = await page.request.get(href!)
    expect(file.status()).toBe(200)
    expect(file.headers()['content-type']).toBe('application/pdf')
    const body = await file.body()
    // A real PDF, not an error page rendered with the wrong header.
    expect(body.subarray(0, 5).toString()).toBe('%PDF-')

    const document = await prisma.document.findFirstOrThrow({
      where: { legalEntityId: entity.id, type: 'TAX_PACKET' },
    })
    expect(document.propertyId).toBeNull()
    // The audit row and the packet's own index must agree about what is in
    // the file - the packet claims one unattached exhibit, so must this.
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'tax.packet_archived', entityId: entity.id },
    })
    const after = entry.after as { exhibitsNotAttached: string[]; exhibitsAttached: number }
    expect(after.exhibitsNotAttached).toHaveLength(1)
    expect(after.exhibitsAttached).toBe(0)
  })

  test('archives each export separately rather than overwriting the last', async ({ page }) => {
    // A packet is a claim about the books on a date and the books keep
    // moving, so "the packet the preparer got in February" has to survive
    // February. Two clicks, two documents.
    const entity = await seedEntity('Twice')
    await seedProperty(entity.id, 'Twice House')
    const staff = await createStaff()

    await signIn(page, staff.email)
    await page.goto(`/reports/tax-packet?entity=${entity.id}&year=${YEAR}&basis=cash`)

    const archive = page.getByRole('button', { name: 'Archive packet as PDF' })
    const link = page.getByRole('link', { name: 'Open the archived packet' })

    await archive.click()
    await expect(link).toBeVisible()
    const first = await link.getAttribute('href')

    // Wait for the href to CHANGE, not merely to be visible: it is already
    // visible from the first archive, so a visibility assertion resolves
    // instantly and reads the database before the second action has landed.
    await archive.click()
    await expect(link).not.toHaveAttribute('href', first!)

    const documents = await prisma.document.findMany({
      where: { legalEntityId: entity.id, type: 'TAX_PACKET' },
      select: { storageKey: true },
    })
    expect(documents).toHaveLength(2)
    expect(new Set(documents.map((row) => row.storageKey)).size).toBe(2)
  })
})

test.describe('accessibility', () => {
  test('the tax packet page has no detectable violations', async ({ page }) => {
    const entity = await seedEntity('Axe')
    const { property, unit } = await seedProperty(entity.id, 'Axe House')
    const vendor = await prisma.vendor.create({
      data: { name: `AxeVendor-${randomUUID().slice(0, 6)}`, trades: ['plumbing'], w9OnFile: false },
    })
    vendorIds.push(vendor.id)
    await seedPaidJob(property.id, unit.id, vendor.id, 80_000, 'CHECK')

    const staff = await createStaff()
    await signIn(page, staff.email)
    await page.goto(`/reports/tax-packet?entity=${entity.id}&year=${YEAR}&basis=cash`)

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    expect(results.violations).toEqual([])
  })
})
