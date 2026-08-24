// The smart-lock and identity-verification contracts (LEASE-08, R-094; D-7).
//
// ==========================================================================
// TWO MORE SIMULATED ADAPTERS, AND §14 DOES NOT LIST THEM - so the reason
// they are sanctioned where D-15 refused one for retail cash has to be
// stated rather than assumed.
//
// D-15 refused a simulated cash rail because the SETTLEMENT SHAPE was
// unknown: a driver minting fake settlements is untested code that looks
// finished, written against a vendor whose actual message nobody has seen.
// The test that distinguishes the two cases is whether the DECISION LOGIC
// can be wrong independently of the vendor's response shape.
//
// Here it can, and it is nearly all of the item. Who may be given an
// unaccompanied code, for how long, on what evidence, and what happens when
// somebody pulls it are ours whatever device is on the door - and a lock
// API's surface (issue a time-boxed code, revoke it, list what happened) is
// the same three calls at every vendor, unlike a settlement webhook. The
// same argument §14 already makes for e-sign.
//
// D-27 GOVERNS THE IDENTITY SIMULATOR, and it is the sharpest application of
// that rule in the product so far. If the simulator answered with the name
// from the `Prospect` row that the decision then compares against, "the ID
// says somebody else" would be dead code no test could ever reach - and that
// branch is the entire reason a self-showing verifies identity at all. So
// the simulator is TOLD a name, separately, and answers with what it was
// told.
// ==========================================================================

/// §14 asks every simulated adapter for "timeout, malformed response,
/// delayed webhook, partial failure". "Delayed webhook" does not apply - both
/// simulators answer inline with no async callback - the same call
/// SCREENING_FAULTS and SYNDICATION_FAULTS already made.
export const LOCK_FAULTS = ['timeout', 'malformed_response', 'device_offline'] as const
export type LockFault = (typeof LOCK_FAULTS)[number]

export interface IssueCodeInput {
  /// The device's own id. Never one of ours.
  externalId: string
  validFrom: Date
  validTo: Date
  /// What the device should show in its own log for this code. A label, not
  /// a name - see `SimulatedSmartLockAdapter` on why it is not the prospect's.
  label: string
}

export interface IssuedCode {
  /// The provider's id for the code it just created.
  providerRef: string
  /// The digits the person types at the door.
  code: string
}

export interface LockEventRecord {
  /// The device's own event id. What makes a repeated sync idempotent.
  providerRef: string
  kind: 'UNLOCKED' | 'DENIED'
  occurredAt: Date
  /// How the device describes whoever tried it. Matched back to one of our
  /// codes by `codeProviderRef` where the device knows; free text where it
  /// does not, which is the case that matters (see `LockEvent`'s own
  /// comment on a null `showingAccessId`).
  actorLabel: string
  codeProviderRef: string | null
}

/**
 * What a smart lock has to be able to do for LEASE-08.
 *
 * THREE CALLS AND NO MORE. Every extra one is a thing a real driver has to
 * implement before it can be swapped in, and none of the rest of a lock
 * vendor's API - battery levels, schedules, user management, firmware - is
 * needed to let a verified prospect into an empty house at a booked time.
 */
export interface SmartLockAdapter {
  readonly name: string
  issueCode(input: IssueCodeInput): Promise<IssuedCode>
  /// Idempotent by contract: revoking an already-revoked code is a success,
  /// because the instant kill must never fail on a second press.
  revokeCode(input: { externalId: string; providerRef: string }): Promise<void>
  events(input: { externalId: string; since: Date }): Promise<LockEventRecord[]>
}

export interface IdentityCheckOutcome {
  /// The provider's own reference. What a later question is taken back to
  /// them with, since none of the evidence is kept here.
  reference: string
  result: 'VERIFIED' | 'FAILED'
  /// The name the provider read OFF THE DOCUMENT. Never echoed back from
  /// anything we already hold (D-27) - the whole point is that it can differ.
  documentName: string
}

/**
 * What an identity provider has to do.
 *
 * IT DOES NOT DECIDE WHETHER THE PERSON MAY COME IN, and it cannot: a
 * provider can say a document is genuine and readable, but only this system
 * knows who booked the slot. The name comparison is `namesAgree` in
 * packages/core/scheduling, on our side of the seam, deliberately.
 *
 * NOTHING IN THE RETURN IS AN IMAGE, a document number or a date of birth.
 * The interface is exactly as narrow as what gets stored (D-108's rule,
 * applied at the seam rather than only at the table).
 */
export interface IdentityAdapter {
  readonly name: string
  verify(input: { prospectId: string; documentName: string }): Promise<IdentityCheckOutcome>
}
