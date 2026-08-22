import { describe, expect, it } from 'vitest'
import {
  type CapitalImprovementFact,
  type EvictionCostFact,
  type IncomeFact,
  type TaxExportFacts,
  type UtilityBillFact,
  type WorkOrderFact,
  buildTaxExport,
} from './export.ts'
import { CHARGE_TYPE_MAPPING, ledgerIncomeMapping, workOrderExpenseLine } from './schedule-e.ts'
import { validateCapitalImprovement } from './validate.ts'

const PROPERTY = 'prop_1'

function facts(overrides: Partial<TaxExportFacts> = {}): TaxExportFacts {
  return {
    legalEntityId: 'ent_1',
    legalEntityName: 'Cedar Holdings LLC',
    year: 2026,
    propertyNames: new Map([[PROPERTY, '12 Cedar Row']]),
    propertyTimezones: new Map([[PROPERTY, 'America/Chicago']]),
    income: [],
    workOrders: [],
    utilityBills: [],
    evictionCosts: [],
    capitalImprovements: [],
    mortgageInterest: [],
    ...overrides,
  }
}

function ledgerPayment(overrides: Partial<IncomeFact> = {}): IncomeFact {
  return {
    source: 'ledger',
    sourceId: 'led_1',
    propertyId: PROPERTY,
    bookedOn: '2026-03-04',
    chargeType: 'RENT',
    // AS THE LEDGER SIGNS IT: money received reduces what is owed.
    amountCents: -145_000,
    description: 'Rent - March',
    ...overrides,
  }
}

function job(overrides: Partial<WorkOrderFact> = {}): WorkOrderFact {
  return {
    id: 'wo_1',
    propertyId: PROPERTY,
    scope: 'Replace kitchen faucet',
    vendorName: 'Ridgeline Plumbing',
    turnoverProjectId: null,
    actualLaborCents: 20_000,
    actualMaterialsCents: 8_000,
    invoiceCents: 26_000,
    closedAt: new Date('2026-03-10T15:00:00Z'),
    invoicePaidAt: new Date('2026-03-20T15:00:00Z'),
    capitalised: false,
    ...overrides,
  }
}

function utilityBill(overrides: Partial<UtilityBillFact> = {}): UtilityBillFact {
  return {
    id: 'ub_1',
    propertyId: PROPERTY,
    utilityType: 'WATER',
    landlordCents: 4_200,
    periodEnd: new Date('2026-06-30T00:00:00Z'),
    ...overrides,
  }
}

function evictionCost(overrides: Partial<EvictionCostFact> = {}): EvictionCostFact {
  return {
    id: 'ec_1',
    propertyId: PROPERTY,
    type: 'FILING_FEE',
    description: 'JP court filing',
    amountCents: 12_100,
    incurredOn: new Date('2026-02-11T00:00:00Z'),
    ...overrides,
  }
}

function capex(overrides: Partial<CapitalImprovementFact> = {}): CapitalImprovementFact {
  return {
    id: 'ci_1',
    propertyId: PROPERTY,
    category: 'ROOF',
    description: 'Full tear-off and replace',
    costCents: 1_450_000,
    inServiceOn: new Date('2026-05-02T00:00:00Z'),
    ...overrides,
  }
}

describe('the Schedule E mapping', () => {
  it('treats a deposit as a liability, never as income', () => {
    expect(CHARGE_TYPE_MAPPING.DEPOSIT).toBe('DEPOSIT_LIABILITY')
  })

  it('books late fees, pet rent and utility reimbursement as rents received', () => {
    for (const type of ['LATE_FEE', 'PET_RENT', 'UTILITY', 'RUBS_ALLOCATION', 'NSF_FEE']) {
      expect(CHARGE_TYPE_MAPPING[type]).toBe('RENTS_RECEIVED')
    }
  })

  it('refuses to classify an OTHER charge', () => {
    expect(ledgerIncomeMapping('OTHER')).toBe('UNMAPPED')
  })

  it('treats subscription rent - a ledger row with no charge - as rents received', () => {
    expect(ledgerIncomeMapping(null)).toBe('RENTS_RECEIVED')
  })

  it('sends a charge type it has never heard of to the exception list', () => {
    expect(ledgerIncomeMapping('SOLAR_LEASEBACK')).toBe('UNMAPPED')
  })

  it('splits turn work from repairs, which is a distinction the form draws', () => {
    expect(workOrderExpenseLine({ turnoverProjectId: 'turn_1' })).toBe('CLEANING_MAINTENANCE')
    expect(workOrderExpenseLine({ turnoverProjectId: null })).toBe('REPAIRS')
  })
})

describe('income', () => {
  it('flips the ledger sign so money received is positive income', () => {
    const result = buildTaxExport(facts({ income: [ledgerPayment()] }), 'cash')
    expect(result.incomeCents).toBe(145_000)
    expect(result.lines[0]?.scheduleELine).toBe(3)
  })

  it('leaves an accrual charge amount alone - it is already positive', () => {
    const result = buildTaxExport(
      facts({
        income: [
          {
            source: 'charge',
            sourceId: 'chg_1',
            propertyId: PROPERTY,
            bookedOn: '2026-03-01',
            chargeType: 'RENT',
            amountCents: 145_000,
            description: 'Rent - March',
          },
        ],
      }),
      'accrual',
    )
    expect(result.incomeCents).toBe(145_000)
  })

  it('makes a refund reduce income rather than adding to it', () => {
    // A REVERSAL is signed the opposite way to the payment it undoes, so the
    // flip that turns a payment into positive income turns this negative.
    const result = buildTaxExport(
      facts({ income: [ledgerPayment({ sourceId: 'led_2', amountCents: 50_000 })] }),
      'cash',
    )
    expect(result.incomeCents).toBe(-50_000)
  })

  it('holds a deposit off the income total and on its own schedule', () => {
    const result = buildTaxExport(
      facts({ income: [ledgerPayment({ chargeType: 'DEPOSIT', amountCents: -145_000 })] }),
      'cash',
    )
    expect(result.incomeCents).toBe(0)
    expect(result.depositLiabilityCents).toBe(145_000)
    expect(result.lines[0]?.section).toBe('DEPOSIT_LIABILITY')
  })

  it('excepts an unclassified charge, with a reason that says what to do', () => {
    const result = buildTaxExport(
      facts({ income: [ledgerPayment({ chargeType: 'OTHER' })] }),
      'cash',
    )
    expect(result.lines).toHaveLength(0)
    expect(result.exceptions).toHaveLength(1)
    expect(result.exceptions[0]?.reason).toContain('no Schedule E mapping')
    expect(result.exceptionCents).toBe(145_000)
  })
})

describe('the accounting basis', () => {
  // The whole reason basis is a parameter: the SAME job books in two
  // different years depending on which one you file.
  const straddling = job({
    closedAt: new Date('2026-12-28T15:00:00Z'),
    invoicePaidAt: new Date('2027-01-06T15:00:00Z'),
  })

  it('books a job on the day the invoice was paid, on a cash basis', () => {
    const result = buildTaxExport(facts({ workOrders: [straddling] }), 'cash')
    expect(result.expenseCents).toBe(0)
    expect(result.counts.outOfYear).toBe(1)
  })

  it('books the same job on the day it closed, on an accrual basis', () => {
    const result = buildTaxExport(facts({ workOrders: [straddling] }), 'accrual')
    expect(result.expenseCents).toBe(26_000)
    expect(result.lines[0]?.bookedOn).toBe('2026-12-28')
  })

  it('never books an unpaid job on a cash basis', () => {
    const result = buildTaxExport(
      facts({ workOrders: [job({ invoicePaidAt: null })] }),
      'cash',
    )
    expect(result.expenseCents).toBe(0)
  })
})

describe('expenses', () => {
  it("takes the invoice, not the recorded actuals - D-42's books number", () => {
    // Parts and labour of $28,000 against a $26,000 bill. Deducting the
    // higher figure claims money the owner was never asked for.
    const result = buildTaxExport(facts({ workOrders: [job()] }), 'cash')
    expect(result.expenseCents).toBe(26_000)
  })

  it('falls back to actuals when no invoice was ever received', () => {
    const result = buildTaxExport(facts({ workOrders: [job({ invoiceCents: null })] }), 'cash')
    expect(result.expenseCents).toBe(28_000)
  })

  it('excepts a job marked paid with no amount recorded', () => {
    const result = buildTaxExport(
      facts({
        workOrders: [job({ invoiceCents: null, actualLaborCents: null, actualMaterialsCents: null })],
      }),
      'cash',
    )
    expect(result.exceptions).toHaveLength(1)
    expect(result.exceptions[0]?.reason).toContain('no invoice or actuals')
  })

  it('books an eviction cost to legal and professional fees on either basis', () => {
    for (const basis of ['cash', 'accrual'] as const) {
      const result = buildTaxExport(facts({ evictionCosts: [evictionCost()] }), basis)
      expect(result.totalsByLine).toContainEqual({
        key: 'LEGAL_PROFESSIONAL',
        line: 10,
        label: 'Legal and other professional fees',
        amountCents: 12_100,
      })
    }
  })

  it("books the owner's utility share on an accrual basis", () => {
    const result = buildTaxExport(facts({ utilityBills: [utilityBill()] }), 'accrual')
    expect(result.expenseCents).toBe(4_200)
    expect(result.lines[0]?.scheduleELine).toBe(17)
  })

  it('excepts it on a cash basis, because nothing records when it was paid', () => {
    const result = buildTaxExport(facts({ utilityBills: [utilityBill()] }), 'cash')
    expect(result.expenseCents).toBe(0)
    expect(result.exceptions[0]?.reason).toContain('No payment date is recorded')
  })
})

describe('capital improvements', () => {
  it('keeps CapEx off the expense total and on its own schedule', () => {
    const result = buildTaxExport(facts({ capitalImprovements: [capex()] }), 'cash')
    expect(result.expenseCents).toBe(0)
    expect(result.capexCents).toBe(1_450_000)
    expect(result.lines[0]?.section).toBe('CAPEX')
    expect(result.lines[0]?.bookedOn).toBe('2026-05-02')
  })

  it('never deducts a capitalised job as a repair as well', () => {
    // The failure this prevents is claiming the same $14,500 twice: once as
    // a repair on line 14 and again as a depreciable asset.
    const result = buildTaxExport(
      facts({
        workOrders: [job({ invoiceCents: 1_450_000, capitalised: true })],
        capitalImprovements: [capex()],
      }),
      'cash',
    )
    expect(result.expenseCents).toBe(0)
    expect(result.capexCents).toBe(1_450_000)
    expect(result.counts.capitalised).toBe(1)
  })

  it('excepts an improvement with no in-service date rather than guessing one', () => {
    const result = buildTaxExport(
      facts({ capitalImprovements: [capex({ inServiceOn: null })] }),
      'cash',
    )
    expect(result.capexCents).toBe(0)
    expect(result.exceptions[0]?.reason).toContain('No in-service date')
  })
})

describe('the year boundary', () => {
  // R-042's bug class pointed at a tax year. A job paid at 6pm Central on
  // 31 December is 00:00 UTC on 1 January - so reading the instant in the
  // server's zone moves the deduction into the following year's return.
  const newYearsEve = job({
    invoicePaidAt: new Date('2027-01-01T00:30:00Z'),
    closedAt: new Date('2027-01-01T00:30:00Z'),
  })

  it("books it in the property's year, not the server's", () => {
    const result = buildTaxExport(facts({ year: 2026, workOrders: [newYearsEve] }), 'cash')
    expect(result.lines[0]?.bookedOn).toBe('2026-12-31')
    expect(result.expenseCents).toBe(26_000)
  })

  it('books the same instant in 2027 for an eastern property', () => {
    const result = buildTaxExport(
      facts({
        year: 2026,
        propertyTimezones: new Map([[PROPERTY, 'Europe/London']]),
        workOrders: [newYearsEve],
      }),
      'cash',
    )
    expect(result.counts.outOfYear).toBe(1)
  })
})

describe('the reconciliation', () => {
  // THE INVARIANT. Every fact leaves by exactly one door. If a future source
  // is added with a `continue` that forgets to count, this fails.
  it('accounts for every row handed in, on both bases', () => {
    const everything = facts({
      income: [
        ledgerPayment(),
        ledgerPayment({ sourceId: 'led_2', chargeType: 'OTHER' }),
        ledgerPayment({ sourceId: 'led_3', chargeType: 'DEPOSIT' }),
        ledgerPayment({ sourceId: 'led_4', chargeType: null }),
      ],
      workOrders: [
        job(),
        job({ id: 'wo_2', capitalised: true }),
        job({ id: 'wo_3', invoicePaidAt: new Date('2024-05-05T00:00:00Z'), closedAt: new Date('2024-05-01T00:00:00Z') }),
        job({ id: 'wo_4', invoiceCents: null, actualLaborCents: null, actualMaterialsCents: null }),
      ],
      utilityBills: [utilityBill(), utilityBill({ id: 'ub_2', periodEnd: new Date('2025-06-30T00:00:00Z') })],
      evictionCosts: [evictionCost(), evictionCost({ id: 'ec_2', incurredOn: new Date('2025-02-11T00:00:00Z') })],
      capitalImprovements: [capex(), capex({ id: 'ci_2', inServiceOn: null })],
    })

    for (const basis of ['cash', 'accrual'] as const) {
      const { counts } = buildTaxExport(everything, basis)
      expect(counts.mapped + counts.excepted + counts.outOfYear + counts.capitalised).toBe(
        counts.facts,
      )
    }
  })
})

describe('validating an improvement', () => {
  const valid = {
    propertyId: PROPERTY,
    category: 'ROOF',
    description: 'Full tear-off and replace',
    costCents: 1_450_000,
    inServiceOn: '2026-05-02',
  }

  it('accepts a complete one', () => {
    expect(validateCapitalImprovement(valid)).toEqual([])
  })

  it('accepts one with no in-service date yet - the export flags it, not the form', () => {
    expect(validateCapitalImprovement({ ...valid, inServiceOn: null })).toEqual([])
  })

  it('refuses a zero or missing cost', () => {
    expect(validateCapitalImprovement({ ...valid, costCents: 0 })).toHaveLength(1)
    expect(validateCapitalImprovement({ ...valid, costCents: null })).toHaveLength(1)
  })

  it('refuses a NaN cost rather than storing it', () => {
    expect(validateCapitalImprovement({ ...valid, costCents: Number.NaN })).toHaveLength(1)
  })

  it('refuses a category it does not know', () => {
    expect(validateCapitalImprovement({ ...valid, category: 'SPACESHIP' })).toHaveLength(1)
  })
})
