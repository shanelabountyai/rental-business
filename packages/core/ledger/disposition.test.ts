import { describe, expect, it } from 'vitest'
import {
  computeDisposition,
  depreciationGuidance,
  dispositionLetterText,
  isUnsupportedDeduction,
} from './disposition.ts'

describe('computeDisposition', () => {
  it('zeroes the liability when deductions fit inside what was held', () => {
    const totals = computeDisposition(200_000, 50_000, 0)
    expect(totals).toEqual({
      heldCents: 200_000,
      deductedCents: 50_000,
      outstandingLedgerCents: 0,
      appliedCents: 50_000,
      refundedCents: 150_000,
      additionalOwedCents: 0,
    })
  })

  it('applies an outstanding ledger balance alongside deductions', () => {
    const totals = computeDisposition(200_000, 50_000, 30_000)
    expect(totals.appliedCents).toBe(80_000)
    expect(totals.refundedCents).toBe(120_000)
    expect(totals.additionalOwedCents).toBe(0)
  })

  it('ignores a credit balance (negative outstanding) rather than adding it to the refund', () => {
    const totals = computeDisposition(200_000, 50_000, -10_000)
    expect(totals.appliedCents).toBe(50_000)
    expect(totals.refundedCents).toBe(150_000)
  })

  it('never refunds more than was held, and discloses the shortfall separately', () => {
    const totals = computeDisposition(100_000, 150_000, 0)
    expect(totals.appliedCents).toBe(100_000)
    expect(totals.refundedCents).toBe(0)
    expect(totals.additionalOwedCents).toBe(50_000)
  })
})

describe('depreciationGuidance', () => {
  it('flags full replacement cost on an item past its useful life - the nine-year-old-carpet case', () => {
    const guidance = depreciationGuidance(90_000, 9, 7)
    expect(guidance.suggestedMaxCents).toBe(0)
    expect(guidance.exceedsGuidance).toBe(true)
  })

  it('prorates a claim on an item partway through its useful life', () => {
    const guidance = depreciationGuidance(70_000, 3, 7)
    // 4/7 of useful life remains.
    expect(guidance.suggestedMaxCents).toBe(40_000)
    expect(guidance.exceedsGuidance).toBe(true)
  })

  it('never discounts a brand-new item (age zero) - the full claim is the suggested max', () => {
    const guidance = depreciationGuidance(50_000, 0, 7)
    expect(guidance.suggestedMaxCents).toBe(50_000)
    expect(guidance.exceedsGuidance).toBe(false)
  })

  it('does not flag a zero-dollar claim regardless of age', () => {
    const guidance = depreciationGuidance(0, 9, 7)
    expect(guidance.exceedsGuidance).toBe(false)
  })
})

describe('isUnsupportedDeduction', () => {
  it('flags a deduction with no work order, inspection item, or document', () => {
    expect(
      isUnsupportedDeduction({ workOrderId: null, inspectionItemId: null, evidenceDocumentCount: 0 }),
    ).toBe(true)
  })

  it('does not flag one backed by any single evidence path', () => {
    expect(
      isUnsupportedDeduction({ workOrderId: 'wo_1', inspectionItemId: null, evidenceDocumentCount: 0 }),
    ).toBe(false)
    expect(
      isUnsupportedDeduction({ workOrderId: null, inspectionItemId: 'item_1', evidenceDocumentCount: 0 }),
    ).toBe(false)
    expect(
      isUnsupportedDeduction({ workOrderId: null, inspectionItemId: null, evidenceDocumentCount: 1 }),
    ).toBe(false)
  })
})

describe('dispositionLetterText', () => {
  const base = {
    tenantName: 'Robin Reviewer',
    addressLine1: '15 Checklist Ave',
    unitName: 'Unit A',
    timezone: 'America/Chicago',
    moveOutOn: new Date('2026-09-30T18:00:00Z'),
  }

  it('itemizes deductions and states the refund due', () => {
    const totals = computeDisposition(200_000, 50_000, 0)
    const text = dispositionLetterText({
      ...base,
      deductions: [{ description: 'Carpet cleaning', amountCents: 50_000 }],
      totals,
    })
    expect(text).toContain('Carpet cleaning: $500.00')
    expect(text).toContain('Amount being refunded to you: $1,500.00')
    expect(text).toContain('has not been reviewed by an attorney')
  })

  it('says plainly when nothing was deducted', () => {
    const totals = computeDisposition(200_000, 0, 0)
    const text = dispositionLetterText({ ...base, deductions: [], totals })
    expect(text).toContain('No deductions were made against your deposit.')
  })

  it('discloses a shortfall rather than a negative refund', () => {
    const totals = computeDisposition(50_000, 80_000, 0)
    const text = dispositionLetterText({
      ...base,
      deductions: [{ description: 'Wall repair', amountCents: 80_000 }],
      totals,
    })
    expect(text).toContain('you still owe $300.00')
    expect(text).not.toContain('refunded')
  })
})
