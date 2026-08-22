import { describe, expect, it } from 'vitest'
import {
  INVOICE_SPLIT_CATEGORIES,
  type SplitInvoiceInput,
  sumSplitCents,
  validateSplitInvoice,
} from './invoice-split.ts'
import { SCHEDULE_E } from '../tax/schedule-e.ts'

// The $900 handyman invoice covering three houses (PAY-10, R-082).
function invoice(overrides: Partial<SplitInvoiceInput> = {}): SplitInvoiceInput {
  return {
    legalEntityId: 'entity_1',
    vendorId: 'vendor_1',
    invoiceNumber: '4471',
    totalCents: 90_000,
    invoicedOn: '2026-03-14',
    splits: [
      { propertyId: 'prop_oak', category: 'REPAIRS', amountCents: 40_000 },
      { propertyId: 'prop_elm', category: 'REPAIRS', amountCents: 30_000 },
      { propertyId: 'prop_cedar', category: 'CLEANING_MAINTENANCE', amountCents: 20_000 },
    ],
    ...overrides,
  }
}

describe('validateSplitInvoice', () => {
  it('accepts splits that add up to the vendor total', () => {
    expect(validateSplitInvoice(invoice())).toEqual([])
    expect(sumSplitCents(invoice().splits)).toBe(90_000)
  })

  it('refuses splits that miss the total, and says by how much', () => {
    const violations = validateSplitInvoice(
      invoice({
        splits: [
          { propertyId: 'prop_oak', category: 'REPAIRS', amountCents: 40_000 },
          { propertyId: 'prop_elm', category: 'REPAIRS', amountCents: 30_000 },
        ],
      }),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0].field).toBe('splits')
    expect(violations[0].message).toContain('$700.00')
    expect(violations[0].message).toContain('$900.00')
    expect(violations[0].message).toContain('under by $200.00')
  })

  // One cent, because a tolerance is exactly what this rule must not have:
  // the amounts are typed off paper, so a penny out is a typo and the moment
  // to catch it is while the paper is in hand.
  it('refuses a one-cent variance', () => {
    const violations = validateSplitInvoice(
      invoice({
        splits: [
          { propertyId: 'prop_oak', category: 'REPAIRS', amountCents: 40_001 },
          { propertyId: 'prop_elm', category: 'REPAIRS', amountCents: 30_000 },
          { propertyId: 'prop_cedar', category: 'REPAIRS', amountCents: 20_000 },
        ],
      }),
    )
    expect(violations.map((v) => v.field)).toEqual(['splits'])
    expect(violations[0].message).toContain('over by $0.01')
  })

  it('needs at least one line', () => {
    const violations = validateSplitInvoice(invoice({ splits: [] }))
    expect(violations.map((v) => v.field)).toEqual(['splits'])
  })

  it('puts a bad line’s error on that line', () => {
    const violations = validateSplitInvoice(
      invoice({
        splits: [
          { propertyId: 'prop_oak', category: 'REPAIRS', amountCents: 90_000 },
          { propertyId: '', category: 'NOT_A_CATEGORY', amountCents: 0 },
        ],
      }),
    )
    expect(violations.map((v) => v.field)).toEqual([
      'splits.1.propertyId',
      'splits.1.category',
      'splits.1.amountDollars',
    ])
  })

  // The unique index on VendorInvoiceSplit.workOrderId enforces this across
  // invoices; within one invoice the form has to say so before the write.
  it('refuses the same work order on two lines', () => {
    const violations = validateSplitInvoice(
      invoice({
        splits: [
          { propertyId: 'prop_oak', category: 'REPAIRS', amountCents: 45_000, workOrderId: 'wo_1' },
          { propertyId: 'prop_elm', category: 'REPAIRS', amountCents: 45_000, workOrderId: 'wo_1' },
        ],
      }),
    )
    expect(violations.map((v) => v.field)).toEqual(['splits.1.workOrderId'])
  })

  it('does not pile a sum error on top of an unusable amount', () => {
    const violations = validateSplitInvoice(
      invoice({
        splits: [
          { propertyId: 'prop_oak', category: 'REPAIRS', amountCents: null },
          { propertyId: 'prop_elm', category: 'REPAIRS', amountCents: 30_000 },
        ],
      }),
    )
    expect(violations.map((v) => v.field)).toEqual(['splits.0.amountDollars'])
  })

  it('refuses an unpayable invoice header', () => {
    const violations = validateSplitInvoice(
      invoice({ legalEntityId: '', vendorId: '', totalCents: 0, invoicedOn: 'not a date' }),
    )
    expect(violations.map((v) => v.field)).toEqual([
      'legalEntityId',
      'vendorId',
      'totalDollars',
      'invoicedOn',
      'splits',
    ])
  })
})

describe('INVOICE_SPLIT_CATEGORIES', () => {
  // The category IS the export mapping. A key with no Schedule E line behind
  // it would export as an exception every time, which no form should be able
  // to produce.
  it('is entirely Schedule E keys', () => {
    for (const category of INVOICE_SPLIT_CATEGORIES) {
      expect(SCHEDULE_E[category]).toBeDefined()
    }
  })

  it('excludes the lines a vendor cannot bill', () => {
    for (const excluded of ['RENTS_RECEIVED', 'DEPRECIATION', 'MORTGAGE_INTEREST', 'OTHER_INTEREST']) {
      expect(INVOICE_SPLIT_CATEGORIES as readonly string[]).not.toContain(excluded)
    }
  })
})
