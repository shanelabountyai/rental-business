// TCPA consent (R-051b, COMM-02).
//
// ==========================================================================
// THE PRODUCT HAS HAD REVOCATION SINCE R-030 AND NEVER HAD PERMISSION.
//
// `SmsOptOut` records that somebody told us to stop, and `notify()` honours
// it. Nothing recorded that a tenant ever AGREED to be texted - so the only
// gate was withdrawal of a permission the product never established. Under
// the TCPA that is backwards, and the damages are statutory and per-message.
//
// WHAT THE BASIS DOES. Consent is not a boolean, because "they consented" is
// unfalsifiable six months later. What answers a claim is HOW it was
// obtained, and different bases cover different sending:
//
//   EXPRESS_WRITTEN covers everything, including promotional.
//   Everything else covers TRANSACTIONAL messages only - the ones about the
//   tenancy the tenant is already in.
//
// That split is the whole of TCPA's practical shape for this product, and it
// is why `coversPurpose` takes both a basis and a purpose rather than
// answering "is there consent".
// ==========================================================================

export const CONSENT_BASES = [
  'EXPRESS_WRITTEN',
  'EXISTING_RELATIONSHIP',
  'VERBAL',
  'IMPORTED',
] as const
export type ConsentBasisName = (typeof CONSENT_BASES)[number]

export const CONSENT_CHANNELS = ['SMS', 'EMAIL', 'VOICE'] as const
export type ConsentChannelName = (typeof CONSENT_CHANNELS)[number]

/// What a message is FOR. Transactional messages concern the tenancy the
/// recipient is already in; promotional ones solicit. The TCPA treats them
/// differently and so does this product.
export type MessagePurpose = 'TRANSACTIONAL' | 'PROMOTIONAL'

export const BASIS_LABELS: Record<ConsentBasisName, string> = {
  EXPRESS_WRITTEN: 'Express written consent',
  EXISTING_RELATIONSHIP: 'Gave us the number for this tenancy',
  VERBAL: 'Agreed verbally (recorded by staff)',
  IMPORTED: 'Carried in from a prior system',
}

/// Plain sentences for the staff screen. Each says what the basis actually
/// establishes, because "express written" and "verbal" look interchangeable
/// on a dropdown and are not.
export const BASIS_DESCRIPTIONS: Record<ConsentBasisName, string> = {
  EXPRESS_WRITTEN:
    'They were shown a disclosure and agreed to it. The only basis that permits marketing messages.',
  EXISTING_RELATIONSHIP:
    'They provided the number as part of the tenancy. Covers messages about that tenancy only.',
  VERBAL:
    'They agreed on a call and you are recording it. Covers tenancy messages only, and rests on your note.',
  IMPORTED:
    'A prior system says consent exists. Covers tenancy messages only, and records that somebody else made the claim.',
}

/**
 * Whether a basis is strong enough for what is being sent.
 *
 * ONLY EXPRESS_WRITTEN REACHES PROMOTIONAL. The other three record how a
 * number came to be on file, which is a real and defensible basis for
 * messages about the tenancy and is not agreement to be marketed at.
 */
export function coversPurpose(basis: ConsentBasisName, purpose: MessagePurpose): boolean {
  if (purpose === 'PROMOTIONAL') return basis === 'EXPRESS_WRITTEN'
  return true
}

export interface ConsentRecord {
  channel: string
  basis: string
  revokedAt?: Date | null
}

export interface ConsentVerdict {
  allowed: boolean
  /// Why not, for the suppression record. Null when allowed.
  reason: 'no_consent_on_file' | 'consent_withdrawn' | 'basis_too_weak' | null
}

/**
 * Whether these consent records permit one message.
 *
 * A WITHDRAWN RECORD IS NOT AN ABSENT ONE, and the two produce different
 * reasons: "they never agreed" is a gap somebody can close by asking, and
 * "they took it back" is a decision to honour. Recording both as
 * `no_consent_on_file` would hide a withdrawal behind an oversight.
 *
 * Several live records are normal - a tenant can be re-consented on a
 * stronger basis without the earlier one being deleted - so the STRONGEST
 * live record wins rather than the newest. A tenant who gave express written
 * consent last year and had an existing-relationship row backfilled this
 * morning has not been downgraded by the backfill.
 */
export function consentVerdict(
  records: readonly ConsentRecord[],
  channel: ConsentChannelName,
  purpose: MessagePurpose,
): ConsentVerdict {
  const forChannel = records.filter((record) => record.channel === channel)
  if (forChannel.length === 0) {
    return { allowed: false, reason: 'no_consent_on_file' }
  }

  const live = forChannel.filter((record) => record.revokedAt == null)
  if (live.length === 0) {
    return { allowed: false, reason: 'consent_withdrawn' }
  }

  const sufficient = live.some((record) =>
    coversPurpose(record.basis as ConsentBasisName, purpose),
  )
  return sufficient
    ? { allowed: true, reason: null }
    : { allowed: false, reason: 'basis_too_weak' }
}
