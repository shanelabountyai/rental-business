import { describe, expect, it } from 'vitest'
import {
  computeDisposition,
  depositLiabilityCents,
  depreciationGuidance,
  dispositionAsSent,
  dispositionLetterText,
  isUnsupportedDeduction,
  validateDepositRefund,
} from './disposition.ts'

describe('computeDisposition', () => {
  it('zeroes the liability when deductions fit inside what was held', () => {
    const totals = computeDisposition(200_000, 50_000, 0)
    expect(totals).toEqual({
      heldCents: 200_000,
      deductedCents: 50_000,
      outstandingLedgerCents: 0,
      appliedCents: 50_000,
      ledgerAppliedCents: 0,
      refundedCents: 150_000,
      additionalOwedCents: 0,
      uncoveredDeductionsCents: 0,
      ledgerCreditCents: 0,
      creditAppliedCents: 0,
      creditRefundedCents: 0,
      totalRefundCents: 150_000,
    })
  })

  // R-215. Ledger first (R-209), so a small deposit is spent on the arrears
  // and the damage is what is left uncovered - the part only a new charge
  // can make a receivable.
  it('splits the shortfall into uncovered damage and arrears the deposit could not reach', () => {
    const arrearsExceedDeposit = computeDisposition(100_000, 40_000, 130_000)
    expect(arrearsExceedDeposit.ledgerAppliedCents).toBe(100_000)
    expect(arrearsExceedDeposit.uncoveredDeductionsCents).toBe(40_000)
    expect(arrearsExceedDeposit.additionalOwedCents).toBe(70_000)

    const damageOutrunsDeposit = computeDisposition(100_000, 150_000, 30_000)
    expect(damageOutrunsDeposit.ledgerAppliedCents).toBe(30_000)
    expect(damageOutrunsDeposit.uncoveredDeductionsCents).toBe(80_000)
    expect(damageOutrunsDeposit.additionalOwedCents).toBe(80_000)

    expect(computeDisposition(200_000, 50_000, 30_000).uncoveredDeductionsCents).toBe(0)
  })

  it('applies an outstanding ledger balance alongside deductions', () => {
    const totals = computeDisposition(200_000, 50_000, 30_000)
    expect(totals.appliedCents).toBe(80_000)
    expect(totals.refundedCents).toBe(120_000)
    expect(totals.additionalOwedCents).toBe(0)
  })

  // D-303 (Shane, 2026-10-13). This test used to assert the opposite - "ignores
  // a credit balance rather than adding it to the refund" - and was changed on
  // purpose: a tenant who has paid for days they did not live there is owed
  // that money, and the disposition is the last cheque they will ever get.
  it('returns a credit balance with the refund, as its own figure beside the deposit', () => {
    const totals = computeDisposition(200_000, 50_000, -10_000)
    expect(totals.appliedCents).toBe(50_000)
    // Deposit money only, so applied + refunded still accounts for exactly
    // what was held and the deposit liability still closes at zero.
    expect(totals.refundedCents).toBe(150_000)
    expect(totals.appliedCents + totals.refundedCents).toBe(totals.heldCents)
    expect(totals.ledgerCreditCents).toBe(10_000)
    expect(totals.totalRefundCents).toBe(160_000)
    expect(totals.ledgerAppliedCents).toBe(0)
  })

  it('a paid-up tenant who leaves on the 15th gets the deposit and the unused days back', () => {
    // $1,500 rent paid on the 1st of a 30-day month, out on the 15th: the
    // move-out credit (D-302) leaves the ledger $750 in credit.
    const totals = computeDisposition(150_000, 0, -75_000)
    expect(totals.refundedCents).toBe(150_000)
    expect(totals.ledgerCreditCents).toBe(75_000)
    expect(totals.totalRefundCents).toBe(225_000)
    expect(totals.additionalOwedCents).toBe(0)
  })

  it('a tenant in arrears who leaves on the 15th has only the days lived taken from the deposit', () => {
    // The same month unpaid. The credit has already reduced the balance to
    // $750 by the time this reads it, so that - not $1,500 - is what the
    // deposit settles, and there is no credit left over to return.
    const totals = computeDisposition(150_000, 0, 150_000 - 75_000)
    expect(totals.ledgerAppliedCents).toBe(75_000)
    expect(totals.refundedCents).toBe(75_000)
    expect(totals.ledgerCreditCents).toBe(0)
    expect(totals.totalRefundCents).toBe(75_000)
  })

  // D-307, reversing D-303 on this one point. A credit used to be refunded
  // in full while deductions beyond the deposit were invoiced in full: a
  // cheque to the tenant and a bill to the same tenant in one envelope. The
  // credit now meets that excess first. Hand-computed, $2,000 held and a
  // $532.26 credit throughout (rent of $1,500, out on the 20th of a 31-day
  // month: 150000 * 11 / 31).
  describe('a credit against deductions beyond the deposit (D-307)', () => {
    it('credit smaller than the excess: the difference is invoiced and nothing is refunded', () => {
      // $3,000 of deductions: $1,000.00 beyond the deposit, less $532.26.
      const totals = computeDisposition(200_000, 300_000, -53_226)
      expect(totals.appliedCents).toBe(200_000)
      expect(totals.refundedCents).toBe(0)
      expect(totals.ledgerCreditCents).toBe(53_226)
      expect(totals.creditAppliedCents).toBe(53_226)
      expect(totals.creditRefundedCents).toBe(0)
      expect(totals.uncoveredDeductionsCents).toBe(46_774)
      expect(totals.additionalOwedCents).toBe(46_774)
      expect(totals.totalRefundCents).toBe(0)
    })

    it('credit equal to the excess: nothing is invoiced and nothing is refunded', () => {
      // $2,532.26 of deductions: $532.26 beyond the deposit.
      const totals = computeDisposition(200_000, 253_226, -53_226)
      expect(totals.creditAppliedCents).toBe(53_226)
      expect(totals.creditRefundedCents).toBe(0)
      expect(totals.uncoveredDeductionsCents).toBe(0)
      expect(totals.additionalOwedCents).toBe(0)
      expect(totals.refundedCents).toBe(0)
      expect(totals.totalRefundCents).toBe(0)
    })

    it('credit larger than the excess: the difference is refunded and nothing is invoiced', () => {
      // $2,200 of deductions: $200.00 beyond the deposit, $332.26 left over.
      const totals = computeDisposition(200_000, 220_000, -53_226)
      expect(totals.creditAppliedCents).toBe(20_000)
      expect(totals.creditRefundedCents).toBe(33_226)
      expect(totals.uncoveredDeductionsCents).toBe(0)
      expect(totals.additionalOwedCents).toBe(0)
      // Still deposit money only: the deposit is spent, the refund is rent.
      expect(totals.refundedCents).toBe(0)
      expect(totals.totalRefundCents).toBe(33_226)
    })

    it('no excess: the whole credit comes back with the deposit refund, as under D-303', () => {
      // $300 of deductions, all of it inside the deposit.
      const totals = computeDisposition(200_000, 30_000, -53_226)
      expect(totals.appliedCents).toBe(30_000)
      expect(totals.refundedCents).toBe(170_000)
      expect(totals.creditAppliedCents).toBe(0)
      expect(totals.creditRefundedCents).toBe(53_226)
      expect(totals.uncoveredDeductionsCents).toBe(0)
      expect(totals.additionalOwedCents).toBe(0)
      expect(totals.totalRefundCents).toBe(223_226)
    })

    it('the credit is always either applied or returned, to the cent', () => {
      for (const deducted of [0, 30_000, 200_000, 200_001, 220_000, 253_225, 253_226, 253_227, 300_000]) {
        const totals = computeDisposition(200_000, deducted, -53_226)
        expect(totals.creditAppliedCents + totals.creditRefundedCents).toBe(53_226)
        // What the tenant ends up with, net, is the same whichever way it
        // is split: everything they had with the landlord less the damage.
        expect(totals.totalRefundCents - totals.additionalOwedCents).toBe(200_000 + 53_226 - deducted)
      }
    })
  })

  it('never refunds more than was held, and discloses the shortfall separately', () => {
    const totals = computeDisposition(100_000, 150_000, 0)
    expect(totals.appliedCents).toBe(100_000)
    expect(totals.refundedCents).toBe(0)
    expect(totals.additionalOwedCents).toBe(50_000)
  })

  // R-209. `ledgerAppliedCents` is the number the disposition pushes to
  // Stripe as money received; everything else applied is a deduction, which
  // never was on the ledger and must not be credited against it.
  describe('ledgerAppliedCents', () => {
    it('is the whole outstanding balance when the deposit covers it', () => {
      const totals = computeDisposition(200_000, 50_000, 30_000)
      expect(totals.ledgerAppliedCents).toBe(30_000)
    })

    it('is zero when nothing is outstanding, however large the deductions', () => {
      expect(computeDisposition(200_000, 150_000, 0).ledgerAppliedCents).toBe(0)
    })

    it('is zero on a credit balance rather than negative', () => {
      expect(computeDisposition(200_000, 0, -10_000).ledgerAppliedCents).toBe(0)
    })

    it('takes the ledger FIRST when the deposit cannot cover both', () => {
      // $1,000 held, $800 of damage, $400 of arrears. The letter says the
      // $400 outstanding balance "was also applied" unconditionally, so the
      // arrears have to be the part that is actually settled - deductions
      // first would print $400 and settle $200.
      const totals = computeDisposition(100_000, 80_000, 40_000)
      expect(totals.appliedCents).toBe(100_000)
      expect(totals.ledgerAppliedCents).toBe(40_000)
      expect(totals.additionalOwedCents).toBe(20_000)
    })

    it('never exceeds what was actually held', () => {
      // Nothing deducted, $2,000 of arrears, only $500 held.
      const totals = computeDisposition(50_000, 0, 200_000)
      expect(totals.appliedCents).toBe(50_000)
      expect(totals.ledgerAppliedCents).toBe(50_000)
      expect(totals.additionalOwedCents).toBe(150_000)
    })
  })
})

describe('dispositionAsSent', () => {
  // The state after the refund is recorded (D-306): the ledger reads zero,
  // so a recomputation finds no credit at all. The letter said $532.26.
  it('reads the credit back from what was stored, not from a ledger that has since moved', () => {
    const today = computeDisposition(200_000, 30_000, 0)
    expect(today.ledgerCreditCents).toBe(0)

    const sent = dispositionAsSent(today, {
      appliedCents: 30_000,
      refundedCents: 170_000,
      creditAppliedCents: 0,
      creditRefundedCents: 53_226,
    })
    expect(sent.ledgerCreditCents).toBe(53_226)
    expect(sent.totalRefundCents).toBe(223_226)
  })

  // D-307: after the letter the ledger holds only what is left of the
  // credit, so a recomputation would apply it against the same excess a
  // second time and report the tenant as still owing.
  it('reads the applied credit back, and never re-applies what is left of it', () => {
    // As sent: $2,200 deductions on $2,000 held, $532.26 credit, $200
    // applied, $332.26 to return. The ledger now reads -$332.26.
    const today = computeDisposition(200_000, 220_000, -33_226)
    expect(today.creditAppliedCents).toBe(20_000)
    expect(today.creditRefundedCents).toBe(13_226)

    const sent = dispositionAsSent(today, {
      appliedCents: 200_000,
      refundedCents: 0,
      creditAppliedCents: 20_000,
      creditRefundedCents: 33_226,
    })
    expect(sent.ledgerCreditCents).toBe(53_226)
    expect(sent.creditAppliedCents).toBe(20_000)
    expect(sent.creditRefundedCents).toBe(33_226)
    expect(sent.totalRefundCents).toBe(33_226)
    expect(sent.additionalOwedCents).toBe(0)
    expect(sent.uncoveredDeductionsCents).toBe(0)
  })

  it('does not let a charge that landed after the letter shrink the promised refund', () => {
    const today = computeDisposition(200_000, 30_000, 5_000)
    expect(today.refundedCents).toBe(165_000)

    const sent = dispositionAsSent(today, {
      appliedCents: 30_000,
      refundedCents: 170_000,
      creditAppliedCents: 0,
      creditRefundedCents: 0,
    })
    expect(sent.appliedCents).toBe(30_000)
    expect(sent.refundedCents).toBe(170_000)
    expect(sent.totalRefundCents).toBe(170_000)
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

  it('shows a returned credit as its own line, never folded into the deposit refund', () => {
    const text = dispositionLetterText({
      ...base,
      deductions: [],
      totals: computeDisposition(150_000, 0, -75_000),
    })
    expect(text).toContain('Refund of your security deposit: $1,500.00.')
    expect(text).toContain('credit balance of $750.00')
    expect(text).toContain('Total being refunded to you: $2,250.00.')
    expect(text).not.toContain('Amount being refunded to you')
  })

  it('does not say "no refund is due" when the deposit is spent and a credit is coming back', () => {
    const text = dispositionLetterText({
      ...base,
      deductions: [{ description: 'Wall repair', amountCents: 100_000 }],
      totals: computeDisposition(100_000, 100_000, -20_000),
    })
    expect(text).not.toContain('no refund is due')
    expect(text).toContain('Total being refunded to you: $200.00.')
  })

  // D-307. The four figures a tenant has to be able to check are each on a
  // line of their own: the deposit, the deductions, the credit applied, and
  // what is left one way or the other.
  describe('with a credit set against deductions beyond the deposit (D-307)', () => {
    const letter = (deductedCents: number) =>
      dispositionLetterText({
        ...base,
        deductions: [{ description: 'Replace the carpet', amountCents: deductedCents }],
        totals: computeDisposition(200_000, deductedCents, -53_226),
      })

    it('credit smaller than the excess: states the credit applied and the balance still owed', () => {
      const text = letter(300_000)
      expect(text).toContain('accounts for your security deposit of $2,000.00')
      expect(text).toContain('Replace the carpet: $3,000.00')
      expect(text).toContain('Deductions beyond your security deposit: $1,000.00.')
      expect(text).toContain('credit balance of $532.26')
      expect(text).toContain('Credit applied to those deductions: $532.26.')
      expect(text).toContain('you still owe $467.74')
      expect(text).not.toContain('refunded to you')
      expect(text).not.toContain('returned to you')
    })

    it('credit equal to the excess: says nothing is due either way', () => {
      const text = letter(253_226)
      expect(text).toContain('Deductions beyond your security deposit: $532.26.')
      expect(text).toContain('Credit applied to those deductions: $532.26.')
      expect(text).toContain('no refund is due and you owe nothing further')
      expect(text).not.toContain('still owe')
      expect(text).not.toContain('refunded to you')
    })

    it('credit larger than the excess: states the credit applied and the remainder refunded', () => {
      const text = letter(220_000)
      expect(text).toContain('Deductions beyond your security deposit: $200.00.')
      expect(text).toContain('Credit applied to those deductions: $200.00.')
      expect(text).toContain('Remainder of your credit balance being returned to you: $332.26.')
      expect(text).toContain('Total being refunded to you: $332.26.')
      expect(text).not.toContain('still owe')
      expect(text).not.toContain('no refund is due')
    })

    it('no excess: unchanged from D-303, with nothing said about applying the credit', () => {
      const text = letter(30_000)
      expect(text).toContain('Refund of your security deposit: $1,700.00.')
      expect(text).toContain('credit balance of $532.26')
      expect(text).toContain('Total being refunded to you: $2,232.26.')
      expect(text).not.toContain('Credit applied')
      expect(text).not.toContain('beyond your security deposit')
    })
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

describe('depositLiabilityCents', () => {
  const held = {
    heldCents: 200_000,
    appliedCents: 0,
    refundedCents: 0,
    dispositionSentAt: null,
    refundPaidOn: null,
  }

  it('owes the full amount while the money is simply held', () => {
    expect(depositLiabilityCents(held)).toBe(200_000)
  })

  // R-170's defect, as an assertion: the letter promised $1,040 back and
  // nothing left the bank, so the owner still owes $1,040.
  it('still owes the refund after the letter goes out and before it is paid', () => {
    expect(
      depositLiabilityCents({
        ...held,
        appliedCents: 96_000,
        refundedCents: 104_000,
        dispositionSentAt: new Date('2026-08-20T00:00:00Z'),
      }),
    ).toBe(104_000)
  })

  it('releases the liability once the refund is actually paid', () => {
    expect(
      depositLiabilityCents({
        ...held,
        appliedCents: 96_000,
        refundedCents: 104_000,
        dispositionSentAt: new Date('2026-08-20T00:00:00Z'),
        refundPaidOn: new Date('2026-08-28T00:00:00Z'),
      }),
    ).toBe(0)
  })

  it('releases the applied half at the letter even with no refund due', () => {
    expect(
      depositLiabilityCents({
        ...held,
        appliedCents: 200_000,
        dispositionSentAt: new Date('2026-08-20T00:00:00Z'),
      }),
    ).toBe(0)
  })

  it('counts neither event as having happened before its own date', () => {
    const disposed = {
      ...held,
      appliedCents: 96_000,
      refundedCents: 104_000,
      dispositionSentAt: new Date('2027-03-01T00:00:00Z'),
      refundPaidOn: new Date('2027-03-09T00:00:00Z'),
    }
    const yearEnd = new Date('2026-12-31T23:59:59Z')
    expect(depositLiabilityCents(disposed, yearEnd)).toBe(200_000)
    expect(depositLiabilityCents(disposed, new Date('2027-03-05T00:00:00Z'))).toBe(104_000)
    expect(depositLiabilityCents(disposed, new Date('2027-03-31T00:00:00Z'))).toBe(0)
  })
})

describe('validateDepositRefund', () => {
  const today = '2026-09-05'

  it('accepts a check with a number', () => {
    expect(
      validateDepositRefund({ method: 'OFFLINE_CHECK', paidOn: '2026-09-04', reference: '1042' }, today),
    ).toEqual([])
  })

  it('accepts cash with no reference, because there is none to give', () => {
    expect(validateDepositRefund({ method: 'OFFLINE_CASH', paidOn: today }, today)).toEqual([])
  })

  it('demands a reference for anything that carries one', () => {
    const violations = validateDepositRefund({ method: 'ACH', paidOn: today, reference: '  ' }, today)
    expect(violations.map((v) => v.field)).toEqual(['reference'])
  })

  it('refuses a channel money never comes back through and a future date', () => {
    const violations = validateDepositRefund(
      { method: 'HAP_ACH', paidOn: '2026-09-06', reference: 'x' },
      today,
    )
    expect(violations.map((v) => v.field)).toEqual(['method', 'paidOn'])
  })

  it('refuses a date that is not a calendar day at all', () => {
    const violations = validateDepositRefund(
      { method: 'OFFLINE_CASH', paidOn: 'yesterday' },
      today,
    )
    expect(violations.map((v) => v.field)).toEqual(['paidOn'])
  })
})
