// Unaccompanied entry for a self-showing (LEASE-08, R-094). Pure - no
// database, no Next.js, no provider.
//
// ==========================================================================
// WHAT THIS IS DECIDING IS NOT LIKE ANY OTHER CODE IN THE PRODUCT. Every
// other access code here goes to somebody who already has a relationship
// with the property: a vendor with a dispatched job, a tenant who has signed
// a lease. This one goes to a STRANGER WHO SAW A LISTING, so that they can
// walk into a house on their own with nobody there.
//
// Everything below follows from that, and the three rules worth stating up
// front are the ones a smaller version of this feature would have missed:
//
//   * A VACANT UNIT, ALWAYS. LEASE-08 offers self-showings for vacant units
//     and escorted showings for occupied ones, and the difference is not a
//     convenience: an unaccompanied code on an occupied home is a stranger
//     with a key to somebody's house. Checked at issue AND again at reveal,
//     because a unit can be let in between.
//   * THE WINDOW, NOT THE LINK, IS THE CONTROL. The prospect's link lives
//     for days so the identity check can be done in advance; the code
//     answers only in the margin around the slot they booked.
//   * A CODE IS KILLABLE AT ANY MOMENT AND THE KILL IS THE CHEAP PATH.
//     Revoking is not privileged and never asks twice - R-084's reasoning
//     about holds, applied here: gating the safe direction is how the safe
//     direction stops being taken.
// ==========================================================================

/// How long before the booked slot the code starts working, and how long
/// after it stops.
///
/// FIFTEEN MINUTES EACH SIDE, and both numbers are deliberately small. A
/// prospect who arrives early stands outside for a few minutes rather than
/// being handed a house for the afternoon; one who runs over is not locked
/// out mid-viewing. Every extra minute here is unaccompanied time in an
/// empty home that nobody scheduled.
export const ACCESS_MARGIN_MINUTES = 15

export interface AccessWindow {
  validFrom: Date
  validTo: Date
}

export function accessWindow(showing: {
  scheduledStart: Date
  scheduledEnd: Date
}): AccessWindow {
  const margin = ACCESS_MARGIN_MINUTES * 60_000
  return {
    validFrom: new Date(showing.scheduledStart.getTime() - margin),
    validTo: new Date(showing.scheduledEnd.getTime() + margin),
  }
}

export const IDENTITY_CHECK_RESULTS = ['VERIFIED', 'NAME_MISMATCH', 'FAILED'] as const
export type IdentityCheckResultValue = (typeof IDENTITY_CHECK_RESULTS)[number]

/**
 * Whether an identity check clears somebody to be let in on their own.
 *
 * THE NAME COMPARISON HAPPENS HERE, NOT AT THE PROVIDER, and that is the
 * point of it. A provider can tell us the document is genuine and readable;
 * only this system knows who booked the slot. A check that came back
 * "verified" on a genuine licence belonging to somebody else is exactly the
 * case a self-showing has to catch, and it is invisible to anyone looking at
 * the provider's answer alone.
 *
 * The comparison is deliberately forgiving about everything except the
 * substance: case, accents, punctuation, doubled spaces and middle names all
 * differ routinely between a booking form and a driving licence, and a
 * product that refused on any of them would send every second prospect to a
 * phone call. What it will not forgive is a different surname or a different
 * first name.
 */
export function namesAgree(bookedName: string, documentName: string): boolean {
  const parts = (value: string) =>
    value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      // REMOVED, not replaced with a space: an apostrophe inside a name is
      // punctuation, and "O'Brien" against "OBrien" has to agree. A hyphen
      // goes the same way, which is where this is knowingly imperfect -
      // see below.
      .replace(/[^a-z\s]/g, '')
      .split(/\s+/)
      .filter(Boolean)

  const booked = parts(bookedName)
  const document = parts(documentName)
  if (booked.length === 0 || document.length === 0) return false

  // ponytail: first-and-last token comparison. A double-barrelled surname
  // written "Smith-Jones" on one side and "Smith Jones" on the other refuses,
  // because the first collapses to one token and the second stays two. That
  // is the SAFE direction - it sends somebody to a phone call rather than
  // opening a door - and the refusal message says the office can sort it in a
  // minute. Upgrade path if it turns out to be common: compare the joined
  // trailing tokens as well as the last one.
  //
  // First and last, ignoring anything in between. "Ada B. Lovelace" on a
  // licence and "Ada Lovelace" on a booking form are the same person, and a
  // middle name is the single commonest difference between the two.
  const first = booked[0]!
  const last = booked[booked.length - 1]!
  return document[0] === first && document[document.length - 1] === last
}

export const SELF_SHOWING_REFUSALS = [
  'unit_occupied',
  'no_smart_lock',
  'showing_canceled',
  'not_verified',
  'identity_mismatch',
  'revoked',
  'too_early',
  'expired',
] as const
export type SelfShowingRefusal = (typeof SELF_SHOWING_REFUSALS)[number]

/// What the PROSPECT is told, standing at a door with a phone. Every one of
/// these has to say what to do next, because there is nobody there to ask.
export const SELF_SHOWING_REFUSAL_MESSAGES: Record<SelfShowingRefusal, string> = {
  unit_occupied:
    'Somebody is living here now, so this viewing has to be shown by a member of staff. Call the office and they will arrange it — please do not go in.',
  no_smart_lock:
    'This home is not set up for viewing on your own. A member of staff will meet you at the time you booked.',
  showing_canceled: 'This viewing was cancelled. Book another time and we will send a new link.',
  not_verified:
    'Confirm who you are first and this page will show you the entry code at the time you booked.',
  identity_mismatch:
    'The name on the ID does not match the name this viewing was booked under. Call the office — they can sort it out, and it takes a minute.',
  revoked:
    'This entry code has been cancelled. Call the office before going to the property; do not try to get in.',
  too_early:
    'Your code is not live yet. Come back to this page a few minutes before the time you booked and it will be here.',
  expired:
    'This code has expired. If you still want to see the home, book another time and we will send a new link.',
}

export interface SelfShowingInput {
  now: Date
  unitStatus: string
  hasActiveSmartLock: boolean
  showingStatus: string
  scheduledStart: Date
  scheduledEnd: Date
  /// The check that bought the code, or null where none has been passed.
  identity: { result: IdentityCheckResultValue; namesAgree: boolean } | null
  revokedAt: Date | null
}

export type SelfShowingDecision =
  | { refusal: SelfShowingRefusal; window?: undefined }
  | { refusal?: undefined; window: AccessWindow }

/**
 * Whether this code may be shown, right now.
 *
 * RE-DECIDED ON EVERY READ, never once at issue. A code is issued minutes or
 * days before it is used, and in between the unit can be let, the showing can
 * be cancelled and somebody can pull the code. The row says a code exists;
 * this says whether it may be handed over at this moment.
 *
 * ORDER MATTERS, and it is safety-first rather than helpfulness-first: the
 * refusals that mean "do not go to this property" come before the ones that
 * mean "not yet". Somebody whose code was killed because the house was let
 * this morning must be told that, not told to come back in ten minutes.
 */
export function selfShowingDecision(input: SelfShowingInput): SelfShowingDecision {
  if (input.unitStatus !== 'VACANT') return { refusal: 'unit_occupied' }
  if (!input.hasActiveSmartLock) return { refusal: 'no_smart_lock' }
  if (input.showingStatus !== 'BOOKED') return { refusal: 'showing_canceled' }
  if (input.revokedAt) return { refusal: 'revoked' }

  if (!input.identity) return { refusal: 'not_verified' }
  // A genuine document belonging to somebody else is the case this exists
  // for, so a mismatch is its own answer rather than a failure to verify.
  if (input.identity.result === 'NAME_MISMATCH' || !input.identity.namesAgree) {
    return { refusal: 'identity_mismatch' }
  }
  if (input.identity.result !== 'VERIFIED') return { refusal: 'not_verified' }

  const window = accessWindow(input)
  if (input.now.getTime() < window.validFrom.getTime()) return { refusal: 'too_early' }
  if (input.now.getTime() > window.validTo.getTime()) return { refusal: 'expired' }
  return { window }
}

/**
 * Whether a code may be ISSUED at all - the gate before the provider is
 * called.
 *
 * Deliberately the same function. An issue-time check that drifted from the
 * reveal-time check is how a code gets minted for a house that was let this
 * morning, and the way to make them agree for ever is to have one of them.
 * The only difference is that `now` is inside the window by construction at
 * reveal and is not at issue, so issue passes the slot's own start.
 */
export function canIssueSelfShowingCode(
  input: Omit<SelfShowingInput, 'now' | 'revokedAt'>,
): SelfShowingDecision {
  return selfShowingDecision({
    ...input,
    revokedAt: null,
    now: input.scheduledStart,
  })
}
