import { describe, expect, it } from 'vitest'
import {
  documentTemplateBlocks,
  unknownDocumentMergeFields,
  validateDocumentTemplate,
} from './template.ts'

describe('unknownDocumentMergeFields', () => {
  it('accepts every field on the closed catalogue', () => {
    expect(unknownDocumentMergeFields('Dear {{recipient.name}}, re: {{property.address}}.')).toEqual([])
  })

  it('names a typo, not just "invalid"', () => {
    expect(unknownDocumentMergeFields('Dear {{recipient.nmae}},')).toEqual(['recipient.nmae'])
  })

  it('rejects a message-template-only field - the catalogues are separate', () => {
    // tenant.first_name is on comms/merge-fields.ts's MERGE_FIELDS, not on
    // the document catalogue - a template author cannot smuggle an
    // internal-id-adjacent field in through the other list.
    expect(unknownDocumentMergeFields('{{tenant.first_name}}')).toEqual(['tenant.first_name'])
  })
})

describe('validateDocumentTemplate', () => {
  const valid = { name: 'Estoppel letter', documentType: 'ESTOPPEL_CERTIFICATE', body: 'Dear {{recipient.name}}, ...' }

  it('accepts a valid template', () => {
    expect(validateDocumentTemplate(valid)).toEqual([])
  })

  it('requires a name', () => {
    const violations = validateDocumentTemplate({ ...valid, name: '  ' })
    expect(violations.some((v) => v.field === 'name')).toBe(true)
  })

  it('requires a real document type', () => {
    const violations = validateDocumentTemplate({ ...valid, documentType: 'NOT_A_TYPE' })
    expect(violations.some((v) => v.field === 'documentType')).toBe(true)
  })

  it('requires a body', () => {
    const violations = validateDocumentTemplate({ ...valid, body: '' })
    expect(violations.some((v) => v.field === 'body')).toBe(true)
  })

  it('names an unknown merge field rather than a generic error', () => {
    const violations = validateDocumentTemplate({ ...valid, body: 'Dear {{recipient.nmae}},' })
    expect(violations.find((v) => v.field === 'body')?.message).toContain('recipient.nmae')
  })
})

describe('documentTemplateBlocks', () => {
  it('carries heading, meta and paragraphs, and the draft disclaimer', () => {
    const blocks = documentTemplateBlocks({
      templateName: 'Estoppel letter',
      documentType: 'ESTOPPEL_CERTIFICATE',
      recipientName: 'Jordan Blake',
      propertyName: 'Cedar Row',
      bodyText: 'First paragraph.\n\nSecond paragraph.',
      generatedOn: '2026-08-18',
    })
    expect(blocks[0]).toEqual({ kind: 'heading', text: 'Estoppel letter' })
    expect(blocks.some((b) => b.kind === 'meta' && b.text === 'To: Jordan Blake')).toBe(true)
    expect(blocks.filter((b) => b.kind === 'paragraph')).toHaveLength(2)
    const footer = blocks.at(-1)
    expect(footer?.kind).toBe('footer')
    expect(footer?.text).toMatch(/not been reviewed by an attorney/)
  })

  it('drops a blank paragraph rather than emitting an empty block', () => {
    const blocks = documentTemplateBlocks({
      templateName: 'x',
      documentType: 'LETTER',
      recipientName: 'x',
      propertyName: 'x',
      bodyText: 'One.\n\n\n\nTwo.',
      generatedOn: '2026-08-18',
    })
    expect(blocks.filter((b) => b.kind === 'paragraph')).toHaveLength(2)
  })
})
