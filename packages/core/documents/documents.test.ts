import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_TYPES,
  type DocumentInput,
  RETENTION_RULES,
  retentionCutoff,
  validateDocument,
} from './index.ts'

function baseInput(overrides: Partial<DocumentInput> = {}): DocumentInput {
  return {
    propertyId: 'prop_1',
    type: 'UNIT_PHOTO',
    fileName: 'kitchen.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1024,
    ...overrides,
  }
}

describe('validateDocument', () => {
  it('accepts a minimal valid upload', () => {
    expect(validateDocument(baseInput())).toEqual([])
  })

  it('accepts a unit-attached upload', () => {
    expect(validateDocument(baseInput({ unitId: 'unit_1' }))).toEqual([])
  })

  it('rejects a missing property', () => {
    const violations = validateDocument(baseInput({ propertyId: '' }))
    expect(violations).toContainEqual(expect.objectContaining({ field: 'propertyId' }))
  })

  it('rejects an unknown document type', () => {
    const violations = validateDocument(baseInput({ type: 'SOMETHING_ELSE' }))
    expect(violations).toContainEqual(expect.objectContaining({ field: 'type' }))
  })

  it('rejects a zero-byte file', () => {
    const violations = validateDocument(baseInput({ sizeBytes: 0 }))
    expect(violations).toContainEqual(expect.objectContaining({ field: 'file' }))
  })

  it('rejects a file over the size ceiling', () => {
    const violations = validateDocument(baseInput({ sizeBytes: 100 * 1024 * 1024 }))
    expect(violations).toContainEqual(expect.objectContaining({ field: 'file' }))
  })

  it('rejects a blank filename', () => {
    const violations = validateDocument(baseInput({ fileName: '  ' }))
    expect(violations).toContainEqual(expect.objectContaining({ field: 'file' }))
  })
})

describe('retentionCutoff', () => {
  it('has a rule for every document type', () => {
    for (const type of DOCUMENT_TYPES) {
      expect(RETENTION_RULES[type]).toBeDefined()
    }
  })

  it('computes a cutoff N years after creation for a timed rule', () => {
    const cutoff = retentionCutoff('LEASE', new Date('2020-01-15T00:00:00.000Z'))
    expect(cutoff?.toISOString().slice(0, 10)).toBe('2027-01-15')
  })

  it('returns null for a type with no automatic window', () => {
    expect(retentionCutoff('UNIT_PHOTO', new Date())).toBeNull()
    expect(retentionCutoff('APPLICATION', new Date())).toBeNull()
  })
})
