import { describe, expect, it } from 'vitest'
import {
  RECURRING_CHARGE_TYPES,
  describeRecurringCharge,
  isRecurringChargeType,
  validateRecurringCharge,
} from './recurring.ts'

const base = {
  type: 'PET_RENT',
  amountCents: 3_500,
  label: 'Two cats',
  startsOn: '2026-09-01',
}

describe('validateRecurringCharge', () => {
  it('accepts pet rent and writes the tenant-facing line', () => {
    const result = validateRecurringCharge(base)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.type).toBe('PET_RENT')
    expect(result.description).toBe('Pet rent — Two cats — $35.00/month')
  })

  it('accepts a flat utility fee', () => {
    const result = validateRecurringCharge({ ...base, type: 'UTILITY', label: 'Trash' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.description).toBe('Utility — Trash — $35.00/month')
  })

  it('refuses a charge type no statute would ever let recur', () => {
    // The list exists to stop exactly this: a late fee billed every month
    // with the jurisdiction cap never once consulted.
    for (const type of ['LATE_FEE', 'NSF_FEE', 'RUBS_ALLOCATION', 'RENT']) {
      const result = validateRecurringCharge({ ...base, type })
      expect(result.ok, type).toBe(false)
      if (result.ok) continue
      expect(result.field).toBe('type')
    }
  })

  it('refuses zero as well as negative', () => {
    // A zero line bills $0.00 on every invoice for the rest of the tenancy.
    for (const amountCents of [0, -1, -3_500]) {
      const result = validateRecurringCharge({ ...base, amountCents })
      expect(result.ok, String(amountCents)).toBe(false)
      if (result.ok) continue
      expect(result.field).toBe('amountCents')
    }
  })

  it('refuses fractional cents', () => {
    const result = validateRecurringCharge({ ...base, amountCents: 3_500.5 })
    expect(result.ok).toBe(false)
  })

  it('refuses a blank label, including one that is only spaces', () => {
    for (const label of ['', '   ']) {
      const result = validateRecurringCharge({ ...base, label })
      expect(result.ok, JSON.stringify(label)).toBe(false)
      if (result.ok) continue
      expect(result.field).toBe('label')
    }
  })

  it('refuses an end date on or before the start', () => {
    for (const endsOn of ['2026-09-01', '2026-08-31']) {
      const result = validateRecurringCharge({ ...base, endsOn })
      expect(result.ok, endsOn).toBe(false)
      if (result.ok) continue
      expect(result.field).toBe('endsOn')
    }
  })

  it('accepts an end date after the start, and no end date at all', () => {
    expect(validateRecurringCharge({ ...base, endsOn: '2026-09-02' }).ok).toBe(true)
    expect(validateRecurringCharge({ ...base, endsOn: null }).ok).toBe(true)
    expect(validateRecurringCharge(base).ok).toBe(true)
  })

  it('compares BusinessDates lexicographically across a year boundary', () => {
    // `YYYY-MM-DD` strings sort as dates. This is the property the whole
    // comparison rests on, so it is asserted rather than assumed.
    expect(validateRecurringCharge({ ...base, startsOn: '2026-12-31', endsOn: '2027-01-01' }).ok).toBe(
      true,
    )
    expect(validateRecurringCharge({ ...base, startsOn: '2027-01-01', endsOn: '2026-12-31' }).ok).toBe(
      false,
    )
  })

  it('trims the label before it reaches the invoice line', () => {
    const result = validateRecurringCharge({ ...base, label: '  Two cats  ' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.description).toBe('Pet rent — Two cats — $35.00/month')
  })
})

describe('isRecurringChargeType', () => {
  it('agrees with the list', () => {
    for (const type of RECURRING_CHARGE_TYPES) expect(isRecurringChargeType(type)).toBe(true)
    expect(isRecurringChargeType('PET_FEE')).toBe(false)
  })
})

describe('describeRecurringCharge', () => {
  it('says the amount in dollars, not cents', () => {
    expect(
      describeRecurringCharge({ type: 'PET_RENT', amountCents: 12_050, label: 'Dog' }),
    ).toBe('Pet rent — Dog — $120.50/month')
  })
})
