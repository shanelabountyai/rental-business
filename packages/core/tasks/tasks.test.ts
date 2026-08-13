import { describe, expect, it } from 'vitest'
import {
  type TaskInput,
  type TaskPriorityValue,
  priorityRank,
  requiresAuditOnCompletion,
  requiresProof,
  validateCompletion,
  validateTask,
} from './index.ts'

function baseInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    propertyId: 'prop_1',
    type: 'test.followup',
    subjectType: 'Ticket',
    subjectId: 'ticket_1',
    businessDate: '2026-08-03',
    priority: 'ROUTINE',
    title: 'Call the tenant back',
    ...overrides,
  }
}

describe('validateTask', () => {
  it('accepts a complete, minimal task', () => {
    expect(validateTask(baseInput())).toEqual([])
  })

  it('rejects a blank property, type, subject and title', () => {
    const violations = validateTask(
      baseInput({ propertyId: '', type: '  ', subjectType: '', subjectId: '', title: '' }),
    )
    const fields = violations.map((v) => v.field)
    expect(fields).toEqual(
      expect.arrayContaining(['propertyId', 'type', 'subjectType', 'subjectId', 'title']),
    )
  })

  it('rejects an unknown priority', () => {
    // Cast deliberately: the whole point of this test is that a value the
    // TYPE forbids still has to be rejected at runtime, because a priority
    // arriving from a form is not typed by anything (R-040e).
    const violations = validateTask(baseInput({ priority: 'ASAP' as TaskPriorityValue }))
    expect(violations).toContainEqual(expect.objectContaining({ field: 'priority' }))
  })

  it('rejects a malformed business date', () => {
    const violations = validateTask(baseInput({ businessDate: 'next tuesday' }))
    expect(violations).toContainEqual(expect.objectContaining({ field: 'businessDate' }))
  })
})

describe('priorityRank', () => {
  it('orders emergency before urgent before routine', () => {
    expect(priorityRank('EMERGENCY')).toBeLessThan(priorityRank('URGENT'))
    expect(priorityRank('URGENT')).toBeLessThan(priorityRank('ROUTINE'))
  })

  it('sorts an unrecognised priority last rather than throwing', () => {
    expect(priorityRank('WHATEVER')).toBeGreaterThan(priorityRank('ROUTINE'))
  })
})

describe('the proof and audit registries', () => {
  it('require nothing by default - no real task type exists yet (D-9)', () => {
    expect(requiresProof('anything')).toBe(false)
    expect(requiresAuditOnCompletion('anything')).toBe(false)
    expect(validateCompletion({ type: 'anything', proof: null })).toEqual([])
  })

  it('gates completion on proof once a type is registered', () => {
    const registry = new Set(['meter_reading'])
    expect(requiresProof('meter_reading', registry)).toBe(true)
    expect(
      validateCompletion({ type: 'meter_reading', proof: null }, registry),
    ).toContainEqual(expect.objectContaining({ field: 'proof' }))
    expect(
      validateCompletion({ type: 'meter_reading', proof: { reading: 42 } }, registry),
    ).toEqual([])
  })

  it('treats an empty proof object as no proof at all', () => {
    const registry = new Set(['meter_reading'])
    expect(
      validateCompletion({ type: 'meter_reading', proof: {} }, registry),
    ).toContainEqual(expect.objectContaining({ field: 'proof' }))
  })
})
