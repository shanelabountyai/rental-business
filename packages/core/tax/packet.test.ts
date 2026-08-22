import { describe, expect, it } from 'vitest'
import type { ExportLine } from './export.ts'
import {
  type DepositFact,
  type VendorPaymentFact,
  depositLiabilityAt,
  form1099Candidates,
  scheduleEByProperty,
} from './packet.ts'

const A = 'prop_a'
const B = 'prop_b'
const NAMES = new Map([
  [A, '12 Cedar Row'],
  [B, '9 Birch Lane'],
])
const PROPERTIES = [
  { id: A, name: '12 Cedar Row' },
  { id: B, name: '9 Birch Lane' },
]

function line(overrides: Partial<ExportLine> = {}): ExportLine {
  return {
    section: 'INCOME',
    bookedOn: '2026-03-04',
    propertyId: A,
    propertyName: '12 Cedar Row',
    scheduleELine: 3,
    scheduleELabel: 'Rents received',
    quickBooksAccount: 'Rental Income',
    description: 'Rent',
    amountCents: 145_000,
    sourceKind: 'LedgerEntry',
    sourceId: 'led_1',
    ...overrides,
  }
}

function deposit(overrides: Partial<DepositFact> = {}): DepositFact {
  return {
    id: 'dep_1',
    propertyId: A,
    leaseId: 'lease_1',
    heldCents: 145_000,
    appliedCents: 0,
    refundedCents: 0,
    receivedAt: new Date('2024-06-01T12:00:00Z'),
    dispositionSentAt: null,
    ...overrides,
  }
}

describe('Schedule E per property', () => {
  it('splits one entity’s lines onto the addresses the form actually asks for', () => {
    const result = scheduleEByProperty(
      [
        line({ propertyId: A, amountCents: 145_000 }),
        line({ propertyId: B, sourceId: 'led_2', amountCents: 90_000 }),
        line({
          propertyId: A,
          sourceId: 'wo_1',
          section: 'EXPENSE',
          scheduleELine: 14,
          amountCents: 26_000,
        }),
      ],
      PROPERTIES,
    )

    const cedar = result.find((row) => row.propertyId === A)
    expect(cedar?.incomeCents).toBe(145_000)
    expect(cedar?.expenseCents).toBe(26_000)
    expect(cedar?.netCents).toBe(119_000)
    expect(cedar?.totals).toEqual([
      { key: 'RENTS_RECEIVED', line: 3, label: 'Rents received', amountCents: 145_000 },
      { key: 'REPAIRS', line: 14, label: 'Repairs', amountCents: 26_000 },
    ])

    expect(result.find((row) => row.propertyId === B)?.incomeCents).toBe(90_000)
  })

  it('keeps CapEx, deposits and exceptions off the form', () => {
    // None of the three is a Schedule E line, and each has its own schedule.
    const result = scheduleEByProperty(
      [
        line({ section: 'CAPEX', scheduleELine: null, amountCents: 1_450_000 }),
        line({ section: 'DEPOSIT_LIABILITY', scheduleELine: null, amountCents: 145_000 }),
        line({ section: 'EXCEPTION', scheduleELine: null, amountCents: 5_000 }),
      ],
      PROPERTIES,
    )
    expect(result.every((row) => row.totals.length === 0)).toBe(true)
    expect(result.every((row) => row.netCents === 0)).toBe(true)
  })

  it('gives a property with no activity a row rather than dropping it', () => {
    const result = scheduleEByProperty([line({ propertyId: A })], PROPERTIES)
    expect(result).toHaveLength(2)
    expect(result.find((row) => row.propertyId === B)?.totals).toEqual([])
  })
})

describe('deposit liability at a date', () => {
  const yearEnd = new Date('2026-12-31T23:59:59.999Z')

  it('counts a deposit still held in full', () => {
    const result = depositLiabilityAt([deposit()], yearEnd, NAMES)
    expect(result.totalCents).toBe(145_000)
    expect(result.byProperty[0]?.depositCount).toBe(1)
  })

  it('subtracts applied and refunded once the disposition has been sent', () => {
    // heldCents is GROSS and never decremented - rent-roll.ts has always used
    // this arithmetic, and the schema comment that said otherwise was wrong.
    const result = depositLiabilityAt(
      [
        deposit({
          appliedCents: 45_000,
          refundedCents: 100_000,
          dispositionSentAt: new Date('2026-11-01T12:00:00Z'),
        }),
      ],
      yearEnd,
      NAMES,
    )
    expect(result.totalCents).toBe(0)
  })

  it('still owes the whole deposit when the disposition came AFTER the year end', () => {
    // THE ONE A NAIVE SUM GETS WRONG. Disposed of in March 2027, so on 31
    // December 2026 the owner still held all of it.
    const result = depositLiabilityAt(
      [
        deposit({
          appliedCents: 45_000,
          refundedCents: 100_000,
          dispositionSentAt: new Date('2027-03-04T12:00:00Z'),
        }),
      ],
      yearEnd,
      NAMES,
    )
    expect(result.totalCents).toBe(145_000)
  })

  it('ignores a deposit received after the year end', () => {
    const result = depositLiabilityAt(
      [deposit({ receivedAt: new Date('2027-01-15T12:00:00Z') })],
      yearEnd,
      NAMES,
    )
    expect(result.totalCents).toBe(0)
  })

  it('counts a deposit with no recorded receipt date', () => {
    // Understating a liability is the wrong direction to be wrong in: the row
    // exists, so the money was taken.
    const result = depositLiabilityAt([deposit({ receivedAt: null })], yearEnd, NAMES)
    expect(result.totalCents).toBe(145_000)
  })

  it('groups by property and sorts by name', () => {
    const result = depositLiabilityAt(
      [deposit(), deposit({ id: 'dep_2', propertyId: B, heldCents: 90_000 })],
      yearEnd,
      NAMES,
    )
    // Plain lexicographic, matching every other sort in this codebase, so
    // "12" precedes "9". Numeric collation here and nowhere else would be
    // worse than either choice made consistently.
    expect(result.byProperty.map((row) => row.propertyName)).toEqual([
      '12 Cedar Row',
      '9 Birch Lane',
    ])
    expect(result.totalCents).toBe(235_000)
  })
})

describe('1099-NEC candidates', () => {
  function vendor(overrides: Partial<VendorPaymentFact> = {}): VendorPaymentFact {
    return {
      vendorId: 'v1',
      vendorName: 'Ridgeline Plumbing',
      w9OnFile: true,
      byMethod: { CHECK: 80_000 },
      ...overrides,
    }
  }

  it('flags a vendor over the federal threshold', () => {
    const [row] = form1099Candidates([vendor()])
    expect(row?.requiresForm).toBe(true)
    expect(row?.reportableCents).toBe(80_000)
  })

  it('leaves one under the threshold on the list, unflagged', () => {
    // Shown rather than hidden: "just under" is the filer's judgement to make
    // with the number in front of them.
    const [row] = form1099Candidates([vendor({ byMethod: { CHECK: 40_000 } })])
    expect(row?.requiresForm).toBe(false)
    expect(row?.reportableCents).toBe(40_000)
  })

  it('EXCLUDES card payments — the processor reports those on a 1099-K', () => {
    // $40,000 by card and $30,000 by check is a $30,000 1099-NEC, not a
    // $70,000 one. This is why RPT-07 asks for the list "by payment method".
    const [row] = form1099Candidates([
      vendor({ byMethod: { CARD: 40_000, CHECK: 30_000 } }),
    ])
    expect(row?.totalPaidCents).toBe(70_000)
    expect(row?.cardCents).toBe(40_000)
    expect(row?.reportableCents).toBe(30_000)
    // Under the 60,000 threshold once the card half comes out.
    expect(row?.requiresForm).toBe(false)
  })

  it('flags a vendor over the threshold with no W-9 — the row somebody chases', () => {
    const [row] = form1099Candidates([vendor({ w9OnFile: false })])
    expect(row?.missingW9).toBe(true)
  })

  it('does not flag a missing W-9 below the threshold', () => {
    const [row] = form1099Candidates([
      vendor({ w9OnFile: false, byMethod: { CHECK: 10_000 } }),
    ])
    expect(row?.missingW9).toBe(false)
  })

  it('drops a vendor paid nothing, and sorts by reportable amount', () => {
    const rows = form1099Candidates([
      vendor({ vendorId: 'v1', vendorName: 'Small', byMethod: { CHECK: 10_000 } }),
      vendor({ vendorId: 'v2', vendorName: 'Big', byMethod: { ACH: 500_000 } }),
      vendor({ vendorId: 'v3', vendorName: 'Unpaid', byMethod: {} }),
    ])
    expect(rows.map((row) => row.vendorName)).toEqual(['Big', 'Small'])
  })
})
