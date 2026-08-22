import type { DocumentTypeValue } from './validate.ts'

// Retention rules per document class, as config (DOC-05) - never a literal
// number scattered across whatever code happens to delete a document, the
// same reasoning D-4 applies to jurisdiction numbers.
//
// The reference point for every rule here is `createdAt` (when the file was
// uploaded), not the more precise "post-termination" / "post-decision" points
// DOC-05 actually asks for. Lease termination and screening-decision dates
// belong to entities this build has not reached yet (Lease's own lifecycle is
// R-033; screening is R-060+) - computing against them accurately would mean
// guessing at a shape neither item has decided yet. `createdAt` is the
// conservative, available-today approximation: for a still-current lease it
// UNDER-counts elapsed time (good - it errs toward keeping evidence longer,
// never toward purging it early), and it is the number this module's own
// tests can actually exercise. Revisit when R-033/R-060 exist.
export interface RetentionRule {
  /// Null means no automatic window - kept indefinitely, or purged only by a
  /// deliberate, counsel-reviewed action outside this system.
  years: number | null
  note: string
}

/// Every one of these is a DRAFT default, not legal advice - same posture as
/// R-010's seeded Texas jurisdiction rule. DOC-05's own text ("per counsel's
/// fair-housing-defense guidance") is explicit that some of these need a
/// real attorney's number, not a programmer's guess.
export const RETENTION_RULES: Record<DocumentTypeValue, RetentionRule> = {
  LEASE: { years: 7, note: 'DOC-05: leases retained >= 7 years.' },
  ADDENDUM: { years: 7, note: 'DOC-05: travels with its lease.' },
  NOTICE: { years: null, note: 'Evidence trail - kept indefinitely.' },
  NOTICE_PROOF: { years: null, note: 'Proof of service - kept indefinitely, for the same reason as the notice itself.' },
  INVOICE: { years: null, note: 'No DOC-05 number given; kept indefinitely pending counsel input.' },
  INSURANCE_COI: { years: null, note: 'Kept indefinitely; superseded by a newer COI, not purged.' },
  RENTER_INSURANCE_COI: { years: null, note: 'Kept indefinitely; superseded by a newer certificate, not purged.' },
  W9: { years: null, note: 'Kept indefinitely; a tax record.' },
  INSPECTION_REPORT: { years: null, note: 'PROP-08/deposit-defense evidence - kept indefinitely.' },
  UNIT_PHOTO: { years: null, note: 'PROP-08: persists across turns, permanently.' },
  PROPERTY_PHOTO: { years: null, note: 'Kept indefinitely.' },
  SHUTOFF_PHOTO: { years: null, note: 'Safety-critical reference photo - kept indefinitely.' },
  SCREENING_REPORT: {
    years: null,
    note: 'DOC-05: purge per FCRA/provider terms, keeping only the decision + adverse-action record - a real automated purge needs the decision workflow (R-060+) to exist first. Flagged, not enforced, until then.',
  },
  APPLICATION: {
    years: null,
    note: "DOC-05: retained per counsel's fair-housing-defense guidance - no fixed number given, so no automatic window is set.",
  },
  DEED: { years: null, note: 'PROP-06: title record - kept indefinitely, superseded only on sale.' },
  MORTGAGE_DOC: { years: null, note: 'PROP-06: kept indefinitely; supersedes on refinance, not purged.' },
  INSURANCE_DECLARATION: { years: null, note: 'PROP-06: kept indefinitely; superseded by a newer policy, not purged.' },
  HOA_DOC: { years: null, note: 'PROP-06: kept indefinitely.' },
  WARRANTY_DOC: { years: null, note: 'PROP-06: kept indefinitely; expiry is tracked on the Warranty record, not by purging the document.' },
  MAINTENANCE_PHOTO: { years: null, note: 'MAINT-01: evidence for the request it was attached to - kept indefinitely.' },
  COMPLETION_PHOTO: { years: null, note: 'MAINT-03: the vendor’s proof the work was done - kept indefinitely, and the thing a chargeback or an insurance claim is argued from.' },
  COMMS_TRANSCRIPT: {
    years: null,
    note: 'R-052: a court/adjuster packet - kept indefinitely. It is evidence of what was produced and handed over, which outlives the dispute it was produced for.',
  },
  LEDGER_STATEMENT: {
    years: null,
    note: 'R-052: kept indefinitely, and carries the payment processor’s own invoices inside it (D-50) - purging it would discard the underlying records too.',
  },
  LETTER: { years: null, note: 'R-062: PM-authored correspondence - kept indefinitely.' },
  ESTOPPEL_CERTIFICATE: {
    years: null,
    note: 'R-062: what was represented to a buyer/title company at closing - kept indefinitely, the same reasoning a lease itself is kept for.',
  },
  INSPECTION_PHOTO: {
    years: null,
    note: 'R-068: per-item condition evidence, kept indefinitely for the same reason INSPECTION_REPORT is - a locked report is worth nothing if the photos behind it can vanish.',
  },
  ATTORNEY_PACKET: {
    years: null,
    note: 'R-083: what was handed to counsel, and when - kept indefinitely, for the same reason LEDGER_STATEMENT is. It carries the notices and photographs inside it (D-50), so purging it would discard the underlying evidence too.',
  },
  TAX_PACKET: {
    years: null,
    note: 'R-081d: what the preparer was given for a tax year. Kept indefinitely - a return is examinable for years afterwards and this is the record of what it was filed from.',
  },
  OTHER: { years: null, note: 'Uncategorized - no automatic rule.' },
}

/**
 * The day a document of this type becomes eligible for retention review, or
 * null if it never automatically does.
 *
 * AN UNRECOGNISED TYPE IS `null`, NOT A CRASH. `Document.type` is a free-form
 * text column and every caller reaches this through a `as DocumentTypeValue`
 * cast, so the type system's guarantee stops at the database boundary. It has
 * already been wrong once: `ATTORNEY_PACKET` was written by R-083 and never
 * added to DOCUMENT_TYPES, so the whole retention report threw on any
 * portfolio holding an eviction packet. Both halves are fixed - the value is
 * in the vocabulary now, and a future one that is not can no longer take the
 * report down with it. Erring toward "no automatic window" is the safe
 * direction: it keeps evidence rather than proposing it for purge.
 */
export function retentionCutoff(
  type: DocumentTypeValue,
  createdAt: Date,
): Date | null {
  const rule = RETENTION_RULES[type] as RetentionRule | undefined
  if (rule?.years == null) return null
  const cutoff = new Date(createdAt)
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() + rule.years)
  return cutoff
}
