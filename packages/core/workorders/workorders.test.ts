import { actualTotalCents } from '../approvals/thresholds.ts'
import { describe, expect, it } from 'vitest'
import {
  type AssignmentInput,
  type WorkOrderInput,
  activeWarranties,
  isWarrantyActive,
  jobCostCents,
  likelyMatchingWarranty,
  validateAssignment,
  validateWorkOrder,
} from './index.ts'

describe('validateWorkOrder', () => {
  const valid: WorkOrderInput = {
    propertyId: 'prop_1',
    unitId: 'unit_1',
    scope: 'Replace the kitchen faucet cartridge.',
    priority: 'URGENT',
  }

  it('accepts a minimal valid work order with no estimate', () => {
    expect(validateWorkOrder(valid)).toEqual([])
  })

  it('accepts a whole-dollar estimate of zero or more', () => {
    expect(validateWorkOrder({ ...valid, estimateCents: 0 })).toEqual([])
    expect(validateWorkOrder({ ...valid, estimateCents: 45_000 })).toEqual([])
  })

  it('rejects a negative or fractional estimate', () => {
    expect(
      validateWorkOrder({ ...valid, estimateCents: -100 }).map((v) => v.field),
    ).toContain('estimateCents')
    expect(
      validateWorkOrder({ ...valid, estimateCents: 100.5 }).map((v) => v.field),
    ).toContain('estimateCents')
  })

  it('requires a property, a unit, scope text, and a real priority', () => {
    expect(
      validateWorkOrder({ ...valid, propertyId: '' }).map((v) => v.field),
    ).toContain('propertyId')
    expect(validateWorkOrder({ ...valid, unitId: '' }).map((v) => v.field)).toContain('unitId')
    expect(validateWorkOrder({ ...valid, scope: '   ' }).map((v) => v.field)).toContain('scope')
    expect(
      validateWorkOrder({ ...valid, priority: 'WHENEVER' }).map((v) => v.field),
    ).toContain('priority')
  })

  it('does not require a ticketId - a standalone work order (a make-ready turn) is valid', () => {
    expect(validateWorkOrder(valid)).toEqual([])
    expect(validateWorkOrder({ ...valid, ticketId: null })).toEqual([])
  })
})

describe('validateAssignment', () => {
  it('accepts exactly a staff member', () => {
    const input: AssignmentInput = { assignedStaffId: 'staff_1' }
    expect(validateAssignment(input)).toEqual([])
  })

  it('accepts exactly a vendor', () => {
    const input: AssignmentInput = { vendorId: 'vendor_1' }
    expect(validateAssignment(input)).toEqual([])
  })

  it('refuses both at once', () => {
    const violations = validateAssignment({ assignedStaffId: 'staff_1', vendorId: 'vendor_1' })
    expect(violations.map((v) => v.field)).toContain('assignee')
  })

  it('refuses neither', () => {
    const violations = validateAssignment({})
    expect(violations.map((v) => v.field)).toContain('assignee')
  })
})

describe('warranty surfacing', () => {
  const now = new Date('2026-08-05')

  it('treats a warranty with no expiration as active', () => {
    expect(isWarrantyActive({ id: 'w1', category: 'HVAC', expiresOn: null }, now)).toBe(true)
  })

  it('treats a future expiration as active and a past one as expired', () => {
    expect(
      isWarrantyActive(
        { id: 'w1', category: 'HVAC', expiresOn: new Date('2027-01-01') },
        now,
      ),
    ).toBe(true)
    expect(
      isWarrantyActive(
        { id: 'w1', category: 'HVAC', expiresOn: new Date('2025-01-01') },
        now,
      ),
    ).toBe(false)
  })

  it('filters to only active warranties', () => {
    const warranties = [
      { id: 'w1', category: 'HVAC', expiresOn: new Date('2027-01-01') },
      { id: 'w2', category: 'ROOF', expiresOn: new Date('2020-01-01') },
      { id: 'w3', category: 'APPLIANCE', expiresOn: null },
    ]
    expect(activeWarranties(warranties, now).map((w) => w.id)).toEqual(['w1', 'w3'])
  })

  it('flags a direct category match as the likely warranty', () => {
    const warranties = [
      { id: 'w1', category: 'ROOF', expiresOn: null },
      { id: 'w2', category: 'HVAC', expiresOn: null },
    ]
    expect(likelyMatchingWarranty('HVAC', warranties)?.id).toBe('w2')
  })

  it('does not guess across categories, and returns null with no category to match', () => {
    const warranties = [{ id: 'w1', category: 'WATER_HEATER', expiresOn: null }]
    expect(likelyMatchingWarranty('PLUMBING', warranties)).toBeNull()
    expect(likelyMatchingWarranty(null, warranties)).toBeNull()
    expect(likelyMatchingWarranty(undefined, warranties)).toBeNull()
  })
})

// The two cost rules, and the fact that they are two (R-032e, D-42).
//
// `jobCostCents` answers what the business is asked to PAY; `actualTotalCents`
// answers whether anything exceeded the approval. They agree on every job
// where the invoice is the largest figure — which is most of them, and is
// exactly why a comment claiming they were "deliberately the same rule"
// survived until R-042's export had to pick one.
//
// This test exists to make a later unification fail loudly rather than
// silently overstate a Schedule E return or silently weaken a ceiling check.
describe('jobCostCents vs actualTotalCents', () => {
  const recordedOverInvoice = {
    actualLaborCents: 80_000,
    actualMaterialsCents: 20_000,
    invoiceCents: 60_000,
  }

  it('DIVERGE when the recorded parts exceed the invoice', () => {
    // The books take what the vendor actually billed.
    expect(jobCostCents(recordedOverInvoice)).toBe(60_000)
    // The control takes the higher figure, because either one over the
    // approval is money the owner did not agree to.
    expect(actualTotalCents(recordedOverInvoice)).toBe(100_000)
  })

  it('agree on the ordinary job, which is why the difference hid', () => {
    const ordinary = {
      actualLaborCents: 40_000,
      actualMaterialsCents: 10_000,
      invoiceCents: 75_000,
    }
    expect(jobCostCents(ordinary)).toBe(75_000)
    expect(actualTotalCents(ordinary)).toBe(75_000)
  })

  it('falls back to the recorded parts before an invoice arrives', () => {
    const noInvoice = {
      actualLaborCents: 30_000,
      actualMaterialsCents: 5_000,
      invoiceCents: null,
    }
    expect(jobCostCents(noInvoice)).toBe(35_000)
    expect(actualTotalCents(noInvoice)).toBe(35_000)
  })

  it('never sums the invoice AND the parts', () => {
    // Double-counting every job whose vendor itemised their own invoice —
    // which is most of them — is the failure both rules are shaped to avoid.
    expect(jobCostCents(recordedOverInvoice)).not.toBe(160_000)
    expect(actualTotalCents(recordedOverInvoice)).not.toBe(160_000)
  })
})
