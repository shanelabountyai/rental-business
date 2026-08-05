// The emergency intake path (MAINT-01's emergency criterion, PROP-03), R-020.
//
// MAINT-01, verbatim: "Given an emergency category (active flooding, sewage
// backup, gas smell, no heat in freezing temps / no AC in dangerous heat,
// electrical burning/sparking, break-in/door won't secure, only toilet
// inoperable, CO alarm), when selected, then safety-first instructions show
// (gas: call gas company & 911 first), the relevant shutoff photo/location
// from the unit record displays, and on-call staff are paged immediately
// regardless of hour."
//
// All eight are here. They are a SEPARATE vocabulary from R-019's seven
// ordinary categories, not extra entries in it, because everything about
// them differs: no clarifying prompts, no troubleshooting script, a
// safety-first screen before anything else, EMERGENCY priority, and a page
// that ignores quiet hours. A single list with a boolean flag would put
// "is this the kind that can kill somebody" behind an `if` at every call
// site instead of in the type.
//
// THE ORDERING OF WHAT THE TENANT SEES IS ITSELF A SAFETY DECISION.
// `selfProtection` comes first and is the only thing shown large: for a gas
// smell, "get out and call 911" has to be read before anything about the
// shutoff, because the correct action for a gas leak is to leave, NOT to go
// looking for a valve. `shutoffType` being null for gas is not an omission -
// see its own comment below.

import type { ShutoffTypeValue } from '../operational/validate.ts'

export const EMERGENCY_CATEGORIES = [
  'GAS_SMELL',
  'CO_ALARM',
  'ELECTRICAL_BURNING',
  'ACTIVE_FLOODING',
  'SEWAGE_BACKUP',
  'NO_HEAT_FREEZING',
  'NO_AC_DANGEROUS_HEAT',
  'BREAK_IN',
  'ONLY_TOILET_INOPERABLE',
] as const

export type EmergencyCategory = (typeof EMERGENCY_CATEGORIES)[number]

const EMERGENCY_SET: ReadonlySet<string> = new Set(EMERGENCY_CATEGORIES)

export function isEmergencyCategory(value: string): value is EmergencyCategory {
  return EMERGENCY_SET.has(value)
}

export interface EmergencyDefinition {
  /// What the tenant taps. D-10's lexicon: the words somebody would actually
  /// use about their own home, in the panic of the moment.
  label: string
  /**
   * What to do RIGHT NOW, before anything else - shown first and largest.
   *
   * Written as an instruction, not a description, and in the order the
   * actions must happen. Where the correct action is to involve emergency
   * services rather than the landlord, it says so plainly and first: a
   * product that buries "call 911" under its own intake form has mistaken
   * its own importance.
   */
  selfProtection: readonly string[]
  /**
   * Which shutoff from the unit record (R-014) helps here, or null when
   * showing one would be actively dangerous or simply irrelevant.
   *
   * NULL FOR GAS ON PURPOSE. The gas shutoff is outside at the meter and
   * turning it off is a job for the gas company; sending somebody who can
   * smell gas to hunt for a valve - possibly with a phone torch, possibly in
   * a basement - is worse advice than "get out". Same for a CO alarm, where
   * the answer is fresh air and 911, and for a break-in, where the answer is
   * the police.
   */
  shutoffType: ShutoffTypeValue | null
  /// Whether this is one where somebody should be woken up. All of them are
  /// today; the field exists because ONLY_TOILET_INOPERABLE is the one MAINT-01
  /// lists that a reasonable operator might later decide is a next-morning
  /// job, and that is a config decision (R-029's on-call rules), not a
  /// property of the tenant's report.
  pagesOnCall: boolean
}

export const EMERGENCY_DEFINITIONS: Record<EmergencyCategory, EmergencyDefinition> = {
  GAS_SMELL: {
    label: 'I smell gas',
    selfProtection: [
      'Leave the home now. Take everyone with you, including pets.',
      'Do not switch anything on or off — not lights, not appliances, not a phone charger. A spark is the danger.',
      'Once you are outside and away, call 911 and your gas company.',
      'Do not go back inside until they tell you it is safe.',
    ],
    // See EmergencyDefinition.shutoffType. Not an omission.
    shutoffType: null,
    pagesOnCall: true,
  },
  CO_ALARM: {
    label: 'My carbon monoxide alarm is going off',
    selfProtection: [
      'Get everyone outside into fresh air now, including pets.',
      'Call 911 from outside.',
      'Do not go back inside until they tell you it is safe.',
    ],
    shutoffType: null,
    pagesOnCall: true,
  },
  ELECTRICAL_BURNING: {
    label: 'Burning smell or sparking from an outlet or switch',
    selfProtection: [
      'Do not touch the outlet, switch, or anything plugged into it.',
      'If you can reach your breaker panel safely, switch off the breaker for that room.',
      'If you see flames or smoke, leave and call 911.',
    ],
    shutoffType: 'BREAKER_PANEL',
    pagesOnCall: true,
  },
  ACTIVE_FLOODING: {
    label: 'Water is flooding in right now',
    selfProtection: [
      'Turn off the water at the main shutoff if you can reach it safely.',
      'Stay out of standing water if it is anywhere near outlets or appliances.',
      'Move what you can out of the water.',
    ],
    shutoffType: 'WATER_MAIN',
    pagesOnCall: true,
  },
  SEWAGE_BACKUP: {
    label: 'Sewage is backing up',
    selfProtection: [
      'Stop running water and stop flushing — it makes the backup worse.',
      'Keep everyone, especially children and pets, away from it. It is a health hazard.',
    ],
    shutoffType: 'WATER_MAIN',
    pagesOnCall: true,
  },
  NO_HEAT_FREEZING: {
    label: 'No heat and it is freezing',
    selfProtection: [
      'Keep everyone in one room and close the doors to it.',
      'Never heat your home with an oven, a gas range, or a generator indoors — that is what causes carbon monoxide poisoning.',
      'If anyone is very young, elderly, or unwell, go somewhere warm and tell us where you are.',
    ],
    shutoffType: null,
    pagesOnCall: true,
  },
  NO_AC_DANGEROUS_HEAT: {
    label: 'No air conditioning and it is dangerously hot',
    selfProtection: [
      'Drink water and stay out of direct sun.',
      'If anyone is very young, elderly, or unwell, go somewhere cool and tell us where you are.',
    ],
    shutoffType: null,
    pagesOnCall: true,
  },
  BREAK_IN: {
    label: 'A break-in, or a door or window will not secure',
    selfProtection: [
      'If anyone may still be inside, leave and call 911 from somewhere safe.',
      'If it is already over, call 911 to report it before anything is moved.',
    ],
    shutoffType: null,
    pagesOnCall: true,
  },
  ONLY_TOILET_INOPERABLE: {
    label: 'My only toilet does not work',
    selfProtection: [
      'If water is overflowing, turn off the small valve behind the toilet.',
    ],
    shutoffType: 'WATER_MAIN',
    pagesOnCall: true,
  },
}

/// The definition for a category, or undefined. Callers that already know the
/// value is an EmergencyCategory index the record directly.
export function emergencyDefinition(
  category: string,
): EmergencyDefinition | undefined {
  return isEmergencyCategory(category) ? EMERGENCY_DEFINITIONS[category] : undefined
}

export interface EmergencyRequestInput {
  category: string
  /// Optional. An emergency submission must never be gated on typing - the
  /// category and the page are what matter, and a required field between a
  /// tenant and "somebody now knows" is a field that costs minutes.
  detail?: string
  /// Safety information for whoever responds, and the one question worth
  /// asking even here: somebody opening a door at 2am needs to know.
  petWarning: boolean | undefined
  entryPermission: boolean | undefined
}

interface Violation {
  field: string
  message: string
}

/**
 * Validates an emergency submission.
 *
 * Deliberately far more permissive than `validateMaintenanceRequest`: the
 * category is the only thing that must be right, because the category is
 * what decides who gets woken up. Pet warning and entry permission are still
 * required answers (both are one tap, and both are information the person
 * driving out at 2am genuinely needs), but there are no clarifying prompts,
 * no troubleshooting gate, and no required free text.
 */
export function validateEmergencyRequest(
  input: EmergencyRequestInput,
): Violation[] {
  const violations: Violation[] = []

  if (!isEmergencyCategory(input.category)) {
    violations.push({ field: 'category', message: 'Choose what is happening.' })
  }
  if (input.entryPermission === undefined) {
    violations.push({
      field: 'entryPermission',
      message: 'Let us know if we can enter if you are not home.',
    })
  }
  if (input.petWarning === undefined) {
    violations.push({
      field: 'petWarning',
      message: 'Let us know if you have a pet at home.',
    })
  }

  return violations
}

/// The transcript that becomes `Ticket.description` - see R-019's
/// formatMaintenanceDescription for the same reasoning.
export function formatEmergencyDescription(
  category: EmergencyCategory,
  input: EmergencyRequestInput,
): string {
  const definition = EMERGENCY_DEFINITIONS[category]
  const lines: string[] = [`EMERGENCY: ${definition.label}.`]

  if (input.detail?.trim()) {
    lines.push('', input.detail.trim())
  }

  lines.push('')
  lines.push(
    input.petWarning ? 'There is a pet at home.' : 'No pet at home.',
  )
  lines.push(
    input.entryPermission
      ? 'Entry permitted if the tenant is not home.'
      : 'Entry NOT permitted unless the tenant is home.',
  )
  lines.push('')
  lines.push('Safety instructions were shown to the tenant before they submitted this.')

  return lines.join('\n')
}
