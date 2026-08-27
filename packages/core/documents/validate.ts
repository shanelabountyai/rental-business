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
  /// R-019: a photo a tenant attaches to a maintenance request, uploaded
  /// before the Ticket exists (see lib/maintenance/actions.ts's
  /// uploadMaintenancePhoto) - distinct from UNIT_PHOTO, which is staff's
  /// versioned condition-over-time library (PROP-08), not tenant-submitted
  /// evidence of a single reported problem.
  'MAINTENANCE_PHOTO',
  /// R-025: a photo a VENDOR uploads through their magic link when the job
  /// is done (MAINT-03's "upload completion photos"). Distinct from
  /// MAINTENANCE_PHOTO, which is the tenant's evidence of the problem, and
  /// from UNIT_PHOTO, which is staff's condition-over-time library - this is
  /// the vendor's own proof of the fix, and R-030's verify-and-close reads
  /// it back to the tenant.
  'COMPLETION_PHOTO',
  /// R-051: proof that a notice was actually served - the photograph of the
  /// notice posted on the door, or the certified-mail receipt. Distinct from
  /// NOTICE, which is the notice ITSELF (the generated PDF that was served);
  /// this is the evidence that the serving happened. An eviction turns on
  /// having both, and conflating them would make "did we serve it" and "what
  /// did we serve" the same question when they are the two separate ones a
  /// court asks.
  'NOTICE_PROOF',
  /// R-052: a communications transcript produced for a court, an attorney or
  /// an adjuster (COMM-05). Archived rather than regenerated on demand, and
  /// the reason is worth stating because "it is derivable, so do not store
  /// it" was the obvious call and is wrong: the underlying rows are immutable
  /// but they KEEP ARRIVING, so a transcript exported in March and
  /// regenerated in June is a different document. "Which transcript did we
  /// give the attorney" then has no answer - the same failure R-051 avoided
  /// by archiving the notice PDF instead of re-rendering the template.
  'COMMS_TRANSCRIPT',
  /// R-052: a court-ready statement of account for one lease and period
  /// (PAY-09), with the payment processor's own invoices appended (D-50).
  /// Archived for the same reason as the transcript above.
  'LEDGER_STATEMENT',
  /// R-062 (DOC-04): a PM-authored, merge-field-templated letter with no
  /// dedicated flow of its own - the generic case the notice/lease/
  /// disposition generators are each too specific to cover.
  'LETTER',
  /// R-062 (DOC-04): "an estoppel certificate for a property sale" is the
  /// PRD's own named example of a document beyond a lease that a PM needs
  /// to generate from a template - kept as its own type rather than
  /// folded into LETTER because a buyer's title company asks for these by
  /// name.
  'ESTOPPEL_CERTIFICATE',
  /// R-067 (LEASE-10): a tenant's own renter's-liability certificate,
  /// tracked per lease. Deliberately distinct from INSURANCE_COI (a
  /// VENDOR's proof of coverage) and INSURANCE_DECLARATION (the property
  /// owner's own policy) - same "different concept, same word" trap those
  /// two already carry a comment about, now a third time.
  'RENTER_INSURANCE_COI',
  /// R-068 phase 2: a condition photo attached to one InspectionItem
  /// (Document.inspectionItemId) - distinct from UNIT_PHOTO (staff's
  /// condition-over-time library, not tied to a specific checklist walk)
  /// and MAINTENANCE_PHOTO/COMPLETION_PHOTO (a reported problem and its
  /// fix, not a room-by-room inspection).
  'INSPECTION_PHOTO',
  /// R-083: the assembled eviction case file handed to counsel. ADDED BY
  /// R-081d, not by R-083 - `lib/evictions/packet.ts` has been writing this
  /// string since R-083 and it was never in this closed vocabulary, so
  /// `RETENTION_RULES[type]` was undefined and `retentionCutoff` threw on any
  /// portfolio holding one. See `retentionCutoff`'s own guard.
  'ATTORNEY_PACKET',
  /// R-081d: the year-end tax packet as one archived PDF (RPT-07). Archived
  /// rather than regenerated, for the same reason as LEDGER_STATEMENT above -
  /// a packet is a claim about the record on a date, and the record keeps
  /// moving.
  'TAX_PACKET',
  /// R-092: the sale/acquisition handoff packet for one property (DOC-06,
  /// RISK-09). Property-keyed, unlike TAX_PACKET, which is per entity - a
  /// handoff is about one house changing hands.
  'HANDOFF_PACKET',
  /// R-085 (RISK-12): the servicemember's own PCS, deployment or enlistment
  /// orders, supplied by the TENANT to invoke §3955. Distinct from
  /// SCRA_CERTIFICATE below in exactly the way NOTICE is distinct from
  /// NOTICE_PROOF: this is the tenant's claim, that is our verification, and
  /// a dispute asks about one or the other.
  'MILITARY_ORDERS',
  /// R-085: the signed PDF certificate a DMDC search returns, which is what
  /// the §3931 affidavit is sworn on. OURS, obtained by us, about a date -
  /// see packages/core/scra for why no adapter mints one.
  'SCRA_CERTIFICATE',
  /// R-090 (RISK-10): the signed amendment that changes who is a party to a
  /// lease - a roommate release, a replacement joining, a whole-tenancy
  /// assignment. Distinct from ADDENDUM, which travels WITH a lease at
  /// signing and is generated from a template a PM authored; this is a
  /// later agreement between the same parties about the lease that already
  /// exists, and its text comes from the change itself.
  'LEASE_AMENDMENT',
  /// R-116 (RISK-08): the condition-as-found photographs of a lease the owner
  /// INHERITED at acquisition, which is the only baseline that tenancy will
  /// ever have. Distinct from INSPECTION_PHOTO, which belongs to a checklist
  /// row somebody walked, and from UNIT_PHOTO, which is the condition-over-
  /// time library - this is evidence of the state a house was handed over in,
  /// and the intake panel's own gap check counts it.
  'CONDITION_BASELINE',
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
