import { mergeFieldsUsed, renderTemplate } from '../comms/merge-fields.ts'
import type { DocumentBlock } from './blocks.ts'
import { DOCUMENT_TYPES, type DocumentTypeValue } from './validate.ts'

// PM-authored document templates (DOC-04, R-062).
//
// REUSES comms/merge-fields.ts's TOKEN SYNTAX AND RENDER ENGINE VERBATIM,
// not a second implementation of the same regex. `renderTemplate()` needs
// no catalogue at all - it only resolves `{{token}}` against a values map
// and reports what it could not fill, so it is already fully generic.
// `mergeFieldsUsed()` (token extraction) is reused too; only the CATALOGUE
// a template's tokens are checked against is document-specific, because
// `packages/core/comms/merge-fields.ts`'s own header states why the two
// catalogues must stay separate: "no internal identifiers, nothing that
// needs a computation" governs BOTH, but a document letter's audience
// (a buyer's title company, a vendor, anyone - not only a tenant with a
// lease) is not the same shape a text message's recipient always is.

export interface DocumentMergeField {
  key: string
  label: string
  example: string
}

/// Closed, same two rules `packages/core/comms/merge-fields.ts`'s own
/// MERGE_FIELDS states: no internal identifiers, nothing requiring a
/// computation. A document template states facts; it does not do
/// arithmetic or carry an id nobody outside this system should see.
export const DOCUMENT_MERGE_FIELDS: readonly DocumentMergeField[] = [
  { key: 'recipient.name', label: 'Recipient name', example: 'Jordan Blake' },
  { key: 'property.name', label: 'Property name', example: 'Cedar Row' },
  { key: 'property.address', label: 'Property street address', example: '18 Cedar Row' },
  { key: 'entity.name', label: 'Owning entity name', example: 'Cedar Row Rentals LLC' },
  { key: 'today', label: "Today's date", example: '2026-08-18' },
  { key: 'staff.name', label: 'Staff member generating this', example: 'Sam Rivera' },
] as const

const DOCUMENT_FIELD_KEYS: ReadonlySet<string> = new Set(
  DOCUMENT_MERGE_FIELDS.map((field) => field.key),
)

/// Referenced fields that are not on the document catalogue - what
/// validation refuses and what a typo becomes, the identical shape
/// `unknownMergeFields` gives message templates.
export function unknownDocumentMergeFields(text: string): string[] {
  return mergeFieldsUsed(text).filter((key) => !DOCUMENT_FIELD_KEYS.has(key))
}

export { renderTemplate }
export type { RenderResult } from '../comms/merge-fields.ts'

export interface DocumentTemplateInput {
  name: string
  documentType: string
  body: string
  /// R-063: per-state selection. Null/absent means "the default, any
  /// state". Format-checked here only (two letters) - the closed list of
  /// states lives in `packages/core/property`, which this module does not
  /// import, to avoid a cycle with `packages/core/leases` (which imports
  /// FROM documents for the `DocumentBlock` type).
  state?: string | null
  /// R-063: set only when documentType is ADDENDUM. The actual closed list
  /// of addendum keys is `packages/core/leases`' `ADDENDUM_KEYS` - checked
  /// there, at lease-generation time, for the same cycle-avoidance reason.
  addendumKey?: string | null
}

/// Named distinctly from every other submodule's own `Violation` - core's
/// top-level barrel (`packages/core/index.ts`) re-exports `documents` and
/// `property` together, and both already had one.
export interface DocumentTemplateViolation {
  field: string
  message: string
}

/**
 * Whether a template may be saved. ON SAVE, the last moment a human is in
 * the room - `validateTemplate`'s own reasoning, restated for documents.
 */
export function validateDocumentTemplate(input: DocumentTemplateInput): DocumentTemplateViolation[] {
  const violations: DocumentTemplateViolation[] = []

  if (!input.name.trim()) {
    violations.push({ field: 'name', message: 'Give the template a name you will recognise.' })
  }
  if (!(DOCUMENT_TYPES as readonly string[]).includes(input.documentType)) {
    violations.push({ field: 'documentType', message: 'Choose what kind of document this generates.' })
  }
  if (!input.body.trim()) {
    violations.push({ field: 'body', message: 'A template needs a body.' })
  }
  if (input.state?.trim() && !/^[A-Z]{2}$/.test(input.state.trim())) {
    violations.push({ field: 'state', message: 'Use a two-letter state code, or leave it blank for every state.' })
  }
  if (input.addendumKey?.trim() && input.documentType !== 'ADDENDUM') {
    violations.push({
      field: 'addendumKey',
      message: 'An addendum key only applies to an ADDENDUM template.',
    })
  }

  // Deliberately NOT validated against DOCUMENT_MERGE_FIELDS below for a
  // LEASE/ADDENDUM template - `packages/core/leases`' own LEASE_MERGE_FIELDS
  // is the catalogue those two document types actually render against, and
  // this module cannot import that without the cycle noted on
  // DocumentTemplateInput above. The save action for those two documentTypes
  // (apps/web/lib/documents/template-actions.ts) calls
  // `unknownLeaseMergeFields` from `@rental/core/leases` itself, where that
  // catalogue is already in scope; this generic check still applies to
  // every other documentType.
  const unknown =
    input.documentType === 'LEASE' || input.documentType === 'ADDENDUM'
      ? []
      : unknownDocumentMergeFields(input.body)
  if (unknown.length > 0) {
    violations.push({
      field: 'body',
      // NAMES THE FIELD - validateTemplate's own reasoning: "invalid merge
      // field" sends somebody hunting through their own paragraph.
      message: `Not a merge field: ${[...new Set(unknown)].map((key) => `{{${key}}}`).join(', ')}. Pick from the list.`,
    })
  }

  return violations
}

export interface DocumentTemplateFacts {
  templateName: string
  documentType: DocumentTypeValue
  recipientName: string
  propertyName: string
  bodyText: string
  generatedOn: string
}

/**
 * The blocks a generated document is made of - heading, meta, the rendered
 * body as paragraphs, and the same draft disclaimer every generated legal
 * artifact in this product carries.
 *
 * Not `noticeDocumentBlocks()` reused directly: that function's "To:" line
 * reads a Lease's `leaseTenants`, which a PM-authored letter has none of -
 * its recipient is whatever free text the template's own merge fields
 * resolved to, matching a letter's real shape.
 */
export function documentTemplateBlocks(facts: DocumentTemplateFacts): DocumentBlock[] {
  const blocks: DocumentBlock[] = [{ kind: 'heading', text: facts.templateName }]

  blocks.push({ kind: 'meta', text: `Date: ${facts.generatedOn}` })
  blocks.push({ kind: 'meta', text: `Property: ${facts.propertyName}` })
  blocks.push({ kind: 'meta', text: `To: ${facts.recipientName}` })

  for (const paragraph of facts.bodyText.split(/\n\s*\n/)) {
    const text = paragraph.trim()
    if (text) blocks.push({ kind: 'paragraph', text })
  }

  blocks.push({
    kind: 'footer',
    text: 'This document was generated from a template maintained by the property manager and has not been reviewed by an attorney. It is not legal advice.',
  })

  return blocks
}
