import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { vendorPaymentTotalsForYear } from './staff-queries.ts'

// Cumulative vendor payment totals by method, for 1099-NEC flagging
// (MAINT-11, R-079) - read from `jobCostCents()`, the same "what we
// actually paid" figure the books already use (D-42), not a second number.

let entityId: string
let propertyId: string
let unitId: string
let vendorId: string
const workOrderIds: string[] = []
const invoiceIds: string[] = []
let staffId: string

beforeAll(async () => {
  const stamp = `vendortotals-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name: stamp,
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  propertyId = property.id
  const unit = await prisma.unit.create({ data: { propertyId, name: `U-${stamp}`, status: 'OCCUPIED' } })
  unitId = unit.id
  const vendor = await prisma.vendor.create({ data: { name: `Vendor-${stamp}`, trades: ['plumbing'] } })
  vendorId = vendor.id
  const staff = await prisma.staffUser.create({
    data: { email: `${stamp}@example.test`, name: 'Vendor Totals Test' },
  })
  staffId = staff.id
})

afterEach(async () => {
  // Invoices first: a split's `workOrderId` is onDelete Restrict on purpose.
  await prisma.vendorInvoice.deleteMany({ where: { id: { in: invoiceIds } } })
  invoiceIds.length = 0
  await prisma.workOrder.deleteMany({ where: { id: { in: workOrderIds } } })
  workOrderIds.length = 0
})

afterAll(async () => {
  await prisma.unit.updateMany({ where: { id: unitId }, data: { status: 'VACANT' } })
  await prisma.vendor.updateMany({ where: { id: vendorId }, data: { active: false } })
  await prisma.property.updateMany({ where: { id: propertyId }, data: { active: false } })
  await prisma.legalEntity.updateMany({ where: { id: entityId }, data: { active: false } })
  await prisma.staffUser.updateMany({ where: { id: staffId }, data: { active: false } })
  await prisma.$disconnect()
})

async function seedPaidJob(paidOn: string, invoiceCents: number, method: string) {
  const workOrder = await prisma.workOrder.create({
    data: {
      propertyId,
      unitId,
      vendorId,
      scope: 'Test job',
      status: 'CLOSED',
      invoiceCents,
      invoicePaidAt: new Date(`${paidOn}T12:00:00Z`),
      invoicePaymentMethod: method,
    },
  })
  workOrderIds.push(workOrder.id)
  return workOrder
}

describe('vendorPaymentTotalsForYear', () => {
  it('sums paid jobs by payment method within the calendar year', async () => {
    await seedPaidJob('2026-03-01', 20_000, 'CHECK')
    await seedPaidJob('2026-06-01', 30_000, 'CHECK')
    await seedPaidJob('2026-09-01', 15_000, 'ACH')
    await seedPaidJob('2025-12-31', 99_999, 'CHECK') // wrong year, excluded

    const totals = await vendorPaymentTotalsForYear(vendorId, 2026)
    expect(totals.byMethod).toEqual({ CHECK: 50_000, ACH: 15_000 })
    expect(totals.totalCents).toBe(65_000)
  })

  it('returns zero totals with nothing paid', async () => {
    const totals = await vendorPaymentTotalsForYear(vendorId, 2030)
    expect(totals.totalCents).toBe(0)
    expect(totals.byMethod).toEqual({})
  })

  // R-082: a vendor paid entirely through split invoices used to total zero
  // here and never cross the 1099 threshold - an under-report against a
  // federal filing obligation, and a silent one.
  it('counts paid split invoices, and does not double-count the jobs they claim', async () => {
    const claimed = await seedPaidJob('2026-03-01', 26_000, 'CHECK')
    await seedPaidJob('2026-04-01', 10_000, 'ACH')

    const invoice = await prisma.vendorInvoice.create({
      data: {
        legalEntityId: entityId,
        vendorId,
        totalCents: 90_000,
        invoicedOn: new Date('2026-03-14T00:00:00Z'),
        paidAt: new Date('2026-03-20T12:00:00Z'),
        paymentMethod: 'CHECK',
        recordedByStaffId: staffId,
        splits: {
          create: [
            { propertyId, category: 'REPAIRS', amountCents: 40_000, workOrderId: claimed.id },
            { propertyId, category: 'REPAIRS', amountCents: 50_000 },
          ],
        },
      },
      select: { id: true },
    })
    invoiceIds.push(invoice.id)

    const totals = await vendorPaymentTotalsForYear(vendorId, 2026)
    // The claimed job's own $260 is gone - the $900 bill carries its share.
    expect(totals.byMethod).toEqual({ CHECK: 90_000, ACH: 10_000 })
    expect(totals.totalCents).toBe(100_000)
  })

  it('never counts an unpaid invoice, however large', async () => {
    const workOrder = await prisma.workOrder.create({
      data: { propertyId, unitId, vendorId, scope: 'Unpaid job', status: 'CLOSED', invoiceCents: 500_000 },
    })
    workOrderIds.push(workOrder.id)

    const totals = await vendorPaymentTotalsForYear(vendorId, new Date().getUTCFullYear())
    expect(totals.totalCents).toBe(0)
  })
})
