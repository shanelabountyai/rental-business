import { describe, expect, it } from 'vitest'
import {
  type AssignmentInput,
  type WorkOrderInput,
  activeWarranties,
  isWarrantyActive,
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
