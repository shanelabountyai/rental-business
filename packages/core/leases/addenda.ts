// Property-specific lease addenda (LEASE-06, R-063).
//
// Pure - no database. Six triggers, all property FACTS rather than
// jurisdiction config (D-4): a pool or a well is true or false about THIS
// property regardless of state, unlike a grace period or a notice hour. Two
// of the six read fields that already existed for another reason
// (`yearBuilt` for R-015's filing cabinet, `hoaInfo` for the same); the
// other four (`hasPool`, `hasWellOrSeptic`, `moldHistoryNotes`,
// `bedbugHistoryNotes`) were added on Property by this item.
//
// A REFUSAL, NOT A SILENT OMISSION, when a template is missing. Picking
// which addenda apply is this module's job; finding text for one that
// applies and has no template is the caller's - see
// `apps/web/lib/leases/esign-staff-actions.ts`, which fails loudly rather
// than generating a lease with a disclosure quietly left out.

export const ADDENDUM_KEYS = [
  /// Federal (42 U.S.C. § 4852d), not state config - applies whenever the
  /// property is pre-1978 OR its year built is unknown. Unknown defaults to
  /// REQUIRED, not skipped: the wrong direction to be wrong in is silence.
  'LEAD_PAINT',
  'MOLD',
  'BEDBUG',
  'HOA_RULES',
  'POOL',
  'WELL_SEPTIC',
] as const
export type AddendumKey = (typeof ADDENDUM_KEYS)[number]

export const ADDENDUM_LABELS: Record<AddendumKey, string> = {
  LEAD_PAINT: 'Lead-based paint disclosure',
  MOLD: 'Mold disclosure',
  BEDBUG: 'Bed bug disclosure',
  HOA_RULES: 'HOA rules addendum',
  POOL: 'Pool/spa addendum',
  WELL_SEPTIC: 'Well/septic addendum',
}

export interface PropertyAddendumFacts {
  yearBuilt: number | null
  hasPool: boolean
  hasWellOrSeptic: boolean
  moldHistoryNotes: string | null
  bedbugHistoryNotes: string | null
  hasHoa: boolean
}

/**
 * Which addenda this property's lease needs, in a stable display order.
 *
 * Each trigger is independent and additive - a property can owe all six or
 * none. Nothing here decides whether a TEMPLATE exists for a triggered
 * addendum; that is `selectAddendumTemplate`'s refusal to make, in the app
 * layer where a DocumentTemplate can actually be queried.
 */
export function applicableAddenda(facts: PropertyAddendumFacts): AddendumKey[] {
  const keys: AddendumKey[] = []
  if (facts.yearBuilt == null || facts.yearBuilt < 1978) keys.push('LEAD_PAINT')
  if (facts.moldHistoryNotes?.trim()) keys.push('MOLD')
  if (facts.bedbugHistoryNotes?.trim()) keys.push('BEDBUG')
  if (facts.hasHoa) keys.push('HOA_RULES')
  if (facts.hasPool) keys.push('POOL')
  if (facts.hasWellOrSeptic) keys.push('WELL_SEPTIC')
  return keys
}

