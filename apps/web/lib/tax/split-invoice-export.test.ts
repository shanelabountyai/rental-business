import { prisma } from '@rental/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { taxExportFacts } from './queries.ts'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// The wiring the pure export tests cannot reach (PAY-10, R-082): that a work
// order named by a split is actually FLAGGED `splitInvoiced` on the way out of
// the database, and that the split's own line arrives. `buildTaxExport`
// already has the decision under test; this has the query under test, and the
// double-count bug lives in exactly the gap between them.

const YEAR = 2026

let entityId: string
let staffId: string
let oakId: string
let elmId: string
let unitId: string
let vendorId: string
let workOrderId: string
const invoiceIds: string[] = []

function scopeOf(): ResolvedScope {
  return {
    selection: { kind: 'all' },
    availableEntities: [{ id: entityId, name: 'R082 Holdings' }],
    availableProperties: [
      { id: oakId, name: 'Oak St', legalEntityId: entityId, timezone: 'America/Chicago' },
      { id: elmId, name: 'Elm Ave', legalEntityId: entityId, timezone: 'America/Chicago' },
    ],
    propertyIds: [oakId, elmId],
    switchable: false,
  } as ResolvedScope
}

async function makeProperty(name: string): Promise<string> {
  const property = await prisma.property.create({
    data: {
      legalEntityId: entityId,
      name,
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77002',
      timezone: 'America/Chicago',
      propertyType: 'SINGLE_FAMILY',
    },
  })
  return property.id
}

beforeAll(async () => {
  const stamp = `r082-${Date.now()}`
  const entity = await prisma.legalEntity.create({ data: { name: stamp, type: 'LLC' } })
  entityId = entity.id
  oakId = await makeProperty(`Oak-${stamp}`)
  elmId = await makeProperty(`Elm-${stamp}`)

  const unit = await prisma.unit.create({
    data: { propertyId: oakId, name: `U-${stamp}`, status: 'OCCUPIED' },
  })
  unitId = unit.id
  const vendor = await prisma.vendor.create({ data: { name: `Ace-${stamp}`, trades: ['handyman'] } })
  vendorId = vendor.id
  const staff = await prisma.staffUser.create({
    data: { email: `${stamp}@example.test`, name: 'R082 Tester' },
  })
  staffId = staff.id

  // A job with its own invoice recorded, which the split will then claim.
  const job = await prisma.workOrder.create({
    data: {
      propertyId: oakId,
      unitId,
      vendorId,
      scope: 'Gutter run',
      status: 'CLOSED',
      invoiceCents: 26_000,
      closedAt: new Date('2026-03-10T15:00:00Z'),
      invoicePaidAt: new Date('2026-03-20T15:00:00Z'),
    },
  })
  workOrderId = job.id
})

afterEach(async () => {
  // Splits cascade with the invoice; the work order and properties survive
  // for the next case.
  await prisma.vendorInvoice.deleteMany({ where: { id: { in: invoiceIds } } })
  invoiceIds.length = 0
})

afterAll(async () => {
  await prisma.workOrder.deleteMany({ where: { id: workOrderId } })
  await prisma.unit.deleteMany({ where: { id: unitId } })
  await prisma.property.deleteMany({ where: { id: { in: [oakId, elmId] } } })
  await prisma.vendor.deleteMany({ where: { id: vendorId } })
  await prisma.staffUser.deleteMany({ where: { id: staffId } })
  await prisma.legalEntity.deleteMany({ where: { id: entityId } })
})

/// `taxExportFacts` returns null for an entity outside scope, which none of
/// these cases are - asserted rather than silently non-null-asserted so a
/// scoping regression fails here as a clear message.
async function exportFor(basis: 'cash' | 'accrual') {
  const report = await taxExportFacts(scopeOf(), entityId, YEAR, basis)
  expect(report).not.toBeNull()
  return report!
}

async function recordSplitInvoice(splits: Array<{ propertyId: string; category: string; amountCents: number; workOrderId?: string }>) {
  const invoice = await prisma.vendorInvoice.create({
    data: {
      legalEntityId: entityId,
      vendorId,
      invoiceNumber: '4471',
      totalCents: splits.reduce((total, split) => total + split.amountCents, 0),
      invoicedOn: new Date('2026-03-14T00:00:00Z'),
      paidAt: new Date('2026-03-20T15:00:00Z'),
      paymentMethod: 'CHECK',
      recordedByStaffId: staffId,
      splits: { create: splits },
    },
    select: { id: true },
  })
  invoiceIds.push(invoice.id)
  return invoice.id
}

describe('taxExportFacts with split vendor invoices', () => {
  it('deducts each share on its own property and drops the work order it claims', async () => {
    await recordSplitInvoice([
      { propertyId: oakId, category: 'REPAIRS', amountCents: 40_000, workOrderId },
      { propertyId: elmId, category: 'CLEANING_MAINTENANCE', amountCents: 50_000 },
    ])

    const report = await exportFor('cash')

    const splitLines = report.lines.filter((line) => line.sourceKind === 'VendorInvoiceSplit')
    expect(splitLines).toHaveLength(2)
    expect(splitLines.map((line) => line.amountCents).sort((a, b) => a - b)).toEqual([40_000, 50_000])

    // The $260 the job carried on its own is gone - claimed by the $400 line
    // above, not deducted twice.
    expect(report.lines.some((line) => line.sourceId === workOrderId)).toBe(false)
    expect(report.counts.splitInvoiced).toBe(1)
    expect(report.expenseCents).toBe(90_000)
  })

  it('still deducts a work order no split claims', async () => {
    await recordSplitInvoice([{ propertyId: elmId, category: 'REPAIRS', amountCents: 50_000 }])

    const report = await exportFor('cash')

    expect(report.counts.splitInvoiced).toBe(0)
    expect(report.lines.some((line) => line.sourceId === workOrderId)).toBe(true)
    expect(report.expenseCents).toBe(50_000 + 26_000)
  })

  // The unique index is the only thing standing between a race and a double
  // deduction, so it is worth one test that it is really there.
  it('refuses a second split on the same work order', async () => {
    await recordSplitInvoice([
      { propertyId: oakId, category: 'REPAIRS', amountCents: 40_000, workOrderId },
    ])
    await expect(
      recordSplitInvoice([
        { propertyId: oakId, category: 'REPAIRS', amountCents: 10_000, workOrderId },
      ]),
    ).rejects.toThrow()
  })

  it('refuses a line that does not add to a positive amount', async () => {
    await expect(
      prisma.vendorInvoiceSplit.create({
        data: {
          vendorInvoiceId: await recordSplitInvoice([
            { propertyId: oakId, category: 'REPAIRS', amountCents: 40_000 },
          ]),
          propertyId: oakId,
          category: 'REPAIRS',
          amountCents: 0,
        },
      }),
    ).rejects.toThrow()
  })
})
