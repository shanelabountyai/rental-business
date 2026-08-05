// Validation for Document writes (DOC-01, R-012). Hand-rolled, matching every
// other packages/core validate.ts in this repo.
//
// DOCUMENT_TYPES is a closed vocabulary, unlike Task.type's free-form string
// (packages/core/units/validate.ts's UNIT_STATUSES precedent) - the schema's
// own comment says this type "drives the retention rules R-012 configures"
// (DOC-05), and a retention rule keyed by an unrecognised type is a retention
// rule silently not applied. Adding a class later is a one-line addition
// here, same cost as Task's free-form string would have been, but with a
// forcing function that reminds the adder to also set its retention rule.

interface Violation {
  field: string
  message: string
}

export const DOCUMENT_TYPES = [
  'LEASE',
  'ADDENDUM',
  'NOTICE',
  'INVOICE',
  'INSURANCE_COI',
  'W9',
  'INSPECTION_REPORT',
  'UNIT_PHOTO',
  'PROPERTY_PHOTO',
  /// R-014: the photo attached to a ShutoffLocation - "the water shutoff
  /// location with the photo stored in the unit record" (master PRD's own
  /// active-leak walkthrough).
  'SHUTOFF_PHOTO',
  'SCREENING_REPORT',
  'APPLICATION',
  /// R-015: the property filing cabinet (PROP-06). INSURANCE_DECLARATION is
  /// deliberately distinct from INSURANCE_COI above - a COI is what a
  /// VENDOR provides to prove their own coverage; a declarations page is
  /// the property owner's own policy.
  'DEED',
  'MORTGAGE_DOC',
  'INSURANCE_DECLARATION',
  'HOA_DOC',
  'WARRANTY_DOC',
  'OTHER',
] as const
export type DocumentTypeValue = (typeof DOCUMENT_TYPES)[number]

/// Only the two entities that exist today (R-008, R-009). Lease, Tenant,
/// Vendor, Ticket and WorkOrder are all real columns on Document already -
/// R-002 modeled the whole shape up front - but attaching to one of them is
/// meaningless before that entity's own CRUD exists to look it up through.
/// Whichever item builds each one adds its own upload entry point; nothing
/// here needs to change when it does.
export interface DocumentInput {
  propertyId: string
  unitId?: string | null
  type: string
  fileName: string
  contentType: string
  sizeBytes: number
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export function validateDocument(input: DocumentInput): Violation[] {
  const violations: Violation[] = []

  if (!input.propertyId.trim()) {
    violations.push({ field: 'propertyId', message: 'A document must belong to a property.' })
  }
  if (!(DOCUMENT_TYPES as readonly string[]).includes(input.type)) {
    violations.push({ field: 'type', message: 'Choose a document type.' })
  }
  if (!input.fileName.trim()) {
    violations.push({ field: 'file', message: 'Choose a file.' })
  }
  if (!input.contentType.trim()) {
    violations.push({ field: 'file', message: 'Could not determine the file type.' })
  }
  if (
    !Number.isInteger(input.sizeBytes) ||
    input.sizeBytes <= 0 ||
    input.sizeBytes > MAX_UPLOAD_BYTES
  ) {
    violations.push({
      field: 'file',
      message: `Choose a file under ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.`,
    })
  }

  return violations
}
