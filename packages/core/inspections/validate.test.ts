import { describe, expect, it } from 'vitest'
import {
  isInspectionType,
  isItemCondition,
  validateInspectionTemplate,
  validateItemRecord,
  validateTemplateItems,
} from './validate.ts'

describe('validateTemplateItems', () => {
  it('refuses an empty checklist', () => {
    expect(validateTemplateItems([])).toHaveLength(1)
  })

  it('flags a blank room or item name, one violation per blank field', () => {
    const violations = validateTemplateItems([
      { room: '', item: 'Ceiling' },
      { room: 'Kitchen', item: '' },
    ])
    expect(violations).toHaveLength(2)
    expect(violations[0]!.field).toBe('items.0.room')
    expect(violations[1]!.field).toBe('items.1.item')
  })

  it('accepts a well-formed checklist', () => {
    expect(
      validateTemplateItems([
        { room: 'Kitchen', item: 'Refrigerator' },
        { room: 'Kitchen', item: 'Sink' },
      ]),
    ).toHaveLength(0)
  })
})

describe('validateInspectionTemplate', () => {
  it('requires a name, in addition to a valid checklist', () => {
    const violations = validateInspectionTemplate({
      name: '',
      items: [{ room: 'Kitchen', item: 'Sink' }],
    })
    expect(violations).toEqual([{ field: 'name', message: 'Name this checklist.' }])
  })

  it('passes with a name and a valid checklist', () => {
    expect(
      validateInspectionTemplate({
        name: 'Standard 3BR',
        items: [{ room: 'Kitchen', item: 'Sink' }],
      }),
    ).toHaveLength(0)
  })
})

describe('validateItemRecord', () => {
  it('requires a real condition', () => {
    expect(validateItemRecord({ condition: '' })).toHaveLength(1)
    expect(validateItemRecord({ condition: 'SPOTLESS' })).toHaveLength(1)
    expect(validateItemRecord({ condition: 'GOOD' })).toHaveLength(0)
  })
})

describe('isInspectionType / isItemCondition', () => {
  it('accepts every real value and rejects garbage', () => {
    expect(isInspectionType('MOVE_IN')).toBe(true)
    expect(isInspectionType('move_in')).toBe(false)
    expect(isItemCondition('DAMAGED')).toBe(true)
    expect(isItemCondition('BROKEN')).toBe(false)
  })
})
