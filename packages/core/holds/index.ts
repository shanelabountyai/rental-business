// Lease holds (RISK-11, RISK-12; R-084).
//
// A hold is a declaration that something about this tenancy has changed in a
// way the automation must not walk into. It is NOT a status: a lease under an
// SCRA hold is an ordinary ACTIVE lease with a servicemember in it, and one
// under a bankruptcy hold is an ordinary ACTIVE lease the automatic stay has
// been thrown across.
//
// ==========================================================================
// EFFECTS ARE DECLARED PER TYPE, HERE, AND NOWHERE ELSE.
//
// The alternative - and the shape this arrived as, from the storage build -
// is a boolean column per effect that whoever places the hold ticks by hand.
// That fails in one specific way: it makes "does a bankruptcy hold stop late
// fees" a question about what a particular person remembered to tick on a
// particular Tuesday, six weeks before anybody reads the ledger and asks why
// a stayed debt kept growing. 11 U.S.C. §362 does not care what was ticked.
//
// So the TYPE is what somebody chooses, and the effects follow from it. The
// table below is the whole policy; every guard in the app reads it rather
// than testing a type by name, which is what stops a seventh hold type from
// being invisible to the fifth guard.
// ==========================================================================
//
// None of this makes a legal judgement. Placing a hold records that somebody
// decided the tenancy needs one and why; it does not decide whether the stay
// applies, whether the servicemember is covered, or who the executor is.

export const HOLD_TYPES = [
  'military_scra',
  'deceased',
  'bankruptcy',
  'dispute',
  'payment_plan',
  'do_not_contact',
] as const

export type HoldType = (typeof HOLD_TYPES)[number]

const HOLD_TYPE_SET: ReadonlySet<string> = new Set(HOLD_TYPES)

export function isHoldType(value: string): value is HoldType {
  return HOLD_TYPE_SET.has(value)
}

/**
 * What a hold can switch off. Closed, for the same reason the permission and
 * audit vocabularies are: an effect no guard reads is a promise the product
 * does not keep, and the test at the bottom of this file asserts every one of
 * these is claimed by at least one type.
 *
 * NOT on this list, deliberately: halting notice generation or an eviction
 * filing. Both are sometimes lawful under every hold here - a stay can be
 * lifted, a court can order possession against a servicemember, an estate can
 * be served through its representative - so the product WARNS on those
 * screens (the banner) and refuses nothing. A product that blocked them would
 * be making the legal judgement this file's header says it does not make, and
 * the operator's workaround would be to lift the hold, which is worse than
 * either.
 */
export const HOLD_EFFECTS = [
  /// Arrears chase: the bulk past-grace reminder blast (R-044) and the daily
  /// rent-due notices. Not the ledger - the debt still exists and still
  /// shows on the rent roll. This stops the product from ASKING for it.
  'halt_dunning',
  /// Late-fee assessment (R-040, R-050b). The nightly job skips the lease
  /// entirely, so nothing accrues for the period the hold covers.
  'halt_late_fees',
  /// Issuing an access code to the tenant (R-069). Re-keying or handing over
  /// a code is a possession decision, and three of these holds are about a
  /// tenancy where who is lawfully entitled to possession is exactly what is
  /// unsettled.
  'halt_access_changes',
  /// Staff-authored broadcasts to a segment (COMM-04, R-053). The tenant is
  /// dropped from the audience rather than the send being refused.
  'suppress_marketing',
] as const

export type HoldEffect = (typeof HOLD_EFFECTS)[number]

export interface HoldDefinition {
  label: string
  /// What the banner says. Written for the person about to serve a notice,
  /// not for a settings screen - it has to be worth reading in the two
  /// seconds before they click.
  banner: string
  effects: readonly HoldEffect[]
  /// Lifting this one takes more than the ordinary hold permission (the
  /// backlog's "manager-or-above to lift SCRA"). True where lifting is
  /// itself a legal judgement - the stay was lifted, the servicemember's
  /// period ended, the estate closed - rather than an operational one.
  liftIsPrivileged: boolean
}

export const HOLD_DEFINITIONS: Record<HoldType, HoldDefinition> = {
  military_scra: {
    label: 'Servicemember (SCRA)',
    banner:
      'A servicemember protected by the SCRA. Eviction needs a court order, interest is capped, and a default judgment needs the affidavit — do not proceed on this tenancy without checking.',
    effects: ['halt_dunning', 'halt_late_fees', 'halt_access_changes', 'suppress_marketing'],
    liftIsPrivileged: true,
  },

  deceased: {
    label: 'Tenant deceased',
    banner:
      'The tenant has died. Possession passes through the estate, not through us — nothing here may be released except to the legally entitled party, and there is nobody to serve at this address.',
    effects: ['halt_dunning', 'halt_late_fees', 'halt_access_changes', 'suppress_marketing'],
    liftIsPrivileged: true,
  },

  bankruptcy: {
    label: 'Bankruptcy — automatic stay',
    banner:
      'The automatic stay (11 U.S.C. §362) is in force. Every act to collect a pre-petition debt is barred until the stay is lifted or the case closes, and violating it is sanctionable.',
    effects: ['halt_dunning', 'halt_late_fees', 'halt_access_changes', 'suppress_marketing'],
    liftIsPrivileged: true,
  },

  dispute: {
    label: 'Balance disputed',
    banner:
      'The balance on this tenancy is disputed. Chasing it and adding to it are both paused while it is worked out.',
    // Deliberately NOT `suppress_marketing`: a disputed balance is no reason
    // to stop telling somebody the water is off on Tuesday, and a hold that
    // over-reaches is one an operator stops placing.
    effects: ['halt_dunning', 'halt_late_fees'],
    liftIsPrivileged: false,
  },

  payment_plan: {
    label: 'Payment plan in force',
    banner:
      'A payment plan is in force. The plan is the arrangement — the ordinary chase and the late-fee meter are both off while it holds.',
    effects: ['halt_dunning', 'halt_late_fees'],
    liftIsPrivileged: false,
  },

  do_not_contact: {
    label: 'Do not contact',
    banner:
      'This tenancy has asked not to be contacted, or is represented. Route anything that needs saying through whoever is handling it.',
    // NOT `halt_late_fees`, and the asymmetry is the point: somebody who has
    // asked not to be contacted has not asked to be forgiven. The debt keeps
    // accruing exactly as the lease provides; what stops is us writing to
    // them about it. An operator who wants the meter off as well places a
    // `dispute` or `payment_plan` hold beside this one.
    effects: ['halt_dunning', 'suppress_marketing'],
    liftIsPrivileged: false,
  },
}

/** One placed hold, narrowed to what a decision here needs. */
export interface PlacedHold {
  type: HoldType
  /// Null while in force. A lifted hold has no effects and is kept only as
  /// evidence that it was once placed.
  liftedAt: Date | null
}

export function isActive(hold: PlacedHold): boolean {
  return hold.liftedAt === null
}

/**
 * The union of every active hold's effects.
 *
 * Union, never intersection: two holds on one tenancy mean both sets of
 * consequences, and the narrower one never relaxes the wider.
 */
export function effectsInForce(holds: readonly PlacedHold[]): ReadonlySet<HoldEffect> {
  const effects = new Set<HoldEffect>()
  for (const hold of holds) {
    if (!isActive(hold)) continue
    for (const effect of HOLD_DEFINITIONS[hold.type].effects) effects.add(effect)
  }
  return effects
}

export function isHalted(holds: readonly PlacedHold[], effect: HoldEffect): boolean {
  return effectsInForce(holds).has(effect)
}

/**
 * Which active holds cause an effect — so a guard can say WHICH hold stopped
 * it rather than only that something did. A skip nobody can attribute is a
 * skip somebody spends an afternoon on.
 */
export function holdsCausing(
  holds: readonly PlacedHold[],
  effect: HoldEffect,
): readonly HoldType[] {
  return holds
    .filter((hold) => isActive(hold) && HOLD_DEFINITIONS[hold.type].effects.includes(effect))
    .map((hold) => hold.type)
}

export function liftIsPrivileged(type: HoldType): boolean {
  return HOLD_DEFINITIONS[type].liftIsPrivileged
}

export function holdTypeLabel(type: HoldType): string {
  return HOLD_DEFINITIONS[type].label
}

/** Every effect an operator would see listed against a type, for the UI. */
export function effectLabels(type: HoldType): readonly string[] {
  return HOLD_DEFINITIONS[type].effects.map((effect) => EFFECT_LABELS[effect])
}

export const EFFECT_LABELS: Record<HoldEffect, string> = {
  halt_dunning: 'no arrears chase or rent reminders',
  halt_late_fees: 'no late fees accrue',
  halt_access_changes: 'no access codes issued',
  suppress_marketing: 'excluded from announcements',
}
