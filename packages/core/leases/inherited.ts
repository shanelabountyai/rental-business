// The inherited-tenancy intake (RISK-08, R-033). Pure - no database.
//
// RISK-08, verbatim: "Acquisition with inherited tenants. Onboarding
// workflow: tenant intake form, estoppel-style confirmation of terms,
// documented deposit transfer status, new lease or documented MTM at first
// opportunity, and baseline 'condition as found' photos ASAP (timestamped -
// you cannot charge move-out damage against a baseline never captured)."
//
// THE WHOLE POINT IS THAT THE GAPS STAY VISIBLE. An inherited tenancy
// arrives with three things missing that a normal tenancy never lacks: an
// agreed statement of terms, a known deposit position, and a
// condition baseline. Each is cheap to establish in the weeks after closing
// and expensive-to-impossible later - the seller stops answering, the tenant
// stops remembering, and the damage that was already there becomes damage
// you cannot prove was already there. So they are not optional fields that
// quietly stay null; they are an explicit outstanding-items list.

export const INHERITED_GAPS = [
  /// The tenant has not yet confirmed that the terms we transcribed from
  /// the seller's paperwork are the terms they actually have.
  'estoppel',
  /// Nobody has established whether the deposit money reached us.
  'deposit_transfer',
  /// No timestamped "this is how we found it" photos exist.
  'condition_baseline',
] as const
export type InheritedGap = (typeof INHERITED_GAPS)[number]

export interface InheritedFacts {
  origin: string
  estoppelConfirmedAt: Date | null
  depositTransferStatus: string
  /// Whether any condition-as-found document has been attached to the
  /// lease. A count rather than a boolean would invite "how many is
  /// enough", which is a judgement nobody can encode.
  hasConditionBaseline: boolean
}

export interface GapDetail {
  gap: InheritedGap
  /// What is missing, in a sentence.
  summary: string
  /// Why it matters, stated on screen rather than assumed. A PM who
  /// understands the consequence chases it; one shown a bare checklist item
  /// does not.
  consequence: string
}

const DETAILS: Record<InheritedGap, Omit<GapDetail, 'gap'>> = {
  estoppel: {
    summary: 'The tenant has not confirmed these terms',
    consequence:
      'Until they do, the rent, dates and deposit here are our reading of the seller’s paperwork rather than anything the tenant has agreed to.',
  },
  deposit_transfer: {
    summary: 'It is not established whether the deposit reached us',
    consequence:
      'In most states the current owner owes the deposit back at move-out whether or not the seller ever handed it over. Establish it now, while the seller still answers the phone.',
  },
  condition_baseline: {
    summary: 'No condition-as-found photos are on file',
    consequence:
      'You cannot charge move-out damage against a baseline that was never captured — damage that predates the acquisition becomes damage you cannot prove predates it.',
  },
}

/**
 * What is still outstanding on an inherited tenancy.
 *
 * Returns an empty list for an APPLICATION-origin lease: none of this
 * applies to a tenancy that came through the front door with an
 * application, a signature and a deposit we collected ourselves.
 */
export function inheritedGaps(facts: InheritedFacts): GapDetail[] {
  if (facts.origin !== 'INHERITED') return []

  const gaps: InheritedGap[] = []
  if (!facts.estoppelConfirmedAt) gaps.push('estoppel')
  // NOT_APPLICABLE is a gap here, not a resolution. It is the default, and
  // on an inherited lease it means nobody ever answered the question - the
  // exact failure this list exists to prevent.
  if (
    facts.depositTransferStatus === 'UNKNOWN' ||
    facts.depositTransferStatus === 'NOT_APPLICABLE'
  ) {
    gaps.push('deposit_transfer')
  }
  if (!facts.hasConditionBaseline) gaps.push('condition_baseline')

  return gaps.map((gap) => ({ gap, ...DETAILS[gap] }))
}

/// The Document.type a condition-as-found photo carries.
///
/// IT USED TO BE `'condition_as_found'`, AND THAT VALUE COULD NEVER HAVE BEEN
/// WRITTEN (R-116). The comment here said Document.type is "deliberately
/// free-form" - the SCHEMA's column is, but `validateDocument` checks every
/// upload against the closed `DOCUMENT_TYPES` vocabulary, so a lowercase
/// value outside that list would have been refused by the only code path that
/// creates a Document. It never surfaced because the write path did not
/// exist: the type was read in one query, set in two tests, and written by no
/// route and no action anywhere in the app, while the intake panel told the
/// owner to "upload the photos below". A member of the vocabulary now, with
/// its own retention rule, and R-116 built the uploader the old comment
/// already assumed.
export const CONDITION_BASELINE_DOCUMENT_TYPE = 'CONDITION_BASELINE'

export const DEPOSIT_TRANSFER_STATUSES = [
  'NOT_APPLICABLE',
  'UNKNOWN',
  'TRANSFERRED',
  'NOT_TRANSFERRED',
] as const
export type DepositTransferStatusValue = (typeof DEPOSIT_TRANSFER_STATUSES)[number]

const DEPOSIT_TRANSFER_LABELS: Record<DepositTransferStatusValue, string> = {
  NOT_APPLICABLE: 'We collected it ourselves',
  UNKNOWN: 'Not yet established',
  TRANSFERRED: 'The seller transferred it',
  NOT_TRANSFERRED: 'The seller kept it',
}

export function depositTransferLabel(status: string): string {
  return DEPOSIT_TRANSFER_LABELS[status as DepositTransferStatusValue] ?? status
}
