import { describe, expect, it } from 'vitest'
import {
  EMERGENCY_CATEGORIES,
  EMERGENCY_DEFINITIONS,
  type EmergencyRequestInput,
  emergencyDefinition,
  formatEmergencyDescription,
  isEmergencyCategory,
  validateEmergencyRequest,
} from './index.ts'
import { MAINTENANCE_CATEGORIES } from './categories.ts'
import { SHUTOFF_TYPES } from '../operational/validate.ts'

// R-020's safety-critical rules. Most of what matters here is not "does the
// code run" but "does it say the right thing to somebody in danger", so
// several of these assert on the CONTENT of the instructions rather than
// only their shape.

describe('the emergency vocabulary', () => {
  it('covers every emergency MAINT-01 names', () => {
    // MAINT-01, verbatim: "active flooding, sewage backup, gas smell, no heat
    // in freezing temps / no AC in dangerous heat, electrical
    // burning/sparking, break-in/door won't secure, only toilet inoperable,
    // CO alarm".
    expect([...EMERGENCY_CATEGORIES].sort()).toEqual(
      [
        'ACTIVE_FLOODING',
        'BREAK_IN',
        'CO_ALARM',
        'ELECTRICAL_BURNING',
        'GAS_SMELL',
        'NO_AC_DANGEROUS_HEAT',
        'NO_HEAT_FREEZING',
        'ONLY_TOILET_INOPERABLE',
        'SEWAGE_BACKUP',
      ].sort(),
    )
  })

  it('never overlaps with the ordinary categories', () => {
    // The two vocabularies drive completely different flows; an overlap
    // would make `emergencyDefinition()` shadow an ordinary category's label
    // and silently route somebody down the wrong path.
    for (const ordinary of MAINTENANCE_CATEGORIES) {
      expect(isEmergencyCategory(ordinary), ordinary).toBe(false)
    }
  })

  it('gives every emergency a definition with real instructions', () => {
    for (const category of EMERGENCY_CATEGORIES) {
      const definition = EMERGENCY_DEFINITIONS[category]
      expect(definition.label.length, category).toBeGreaterThan(5)
      expect(definition.selfProtection.length, category).toBeGreaterThan(0)
      for (const instruction of definition.selfProtection) {
        expect(instruction.length, `${category}: ${instruction}`).toBeGreaterThan(10)
      }
    }
  })

  it('only ever points at a shutoff type the unit record actually has', () => {
    for (const category of EMERGENCY_CATEGORIES) {
      const shutoff = EMERGENCY_DEFINITIONS[category].shutoffType
      if (shutoff !== null) {
        // R-014 owns SHUTOFF_TYPES; a value outside it would look up nothing
        // and silently render "we do not have this on file" forever.
        expect(SHUTOFF_TYPES as readonly string[], category).toContain(shutoff)
      }
    }
  })

  it('pages on call for every emergency', () => {
    for (const category of EMERGENCY_CATEGORIES) {
      expect(EMERGENCY_DEFINITIONS[category].pagesOnCall, category).toBe(true)
    }
  })
})

describe('safety-first instructions', () => {
  it('tells a gas-smell reporter to leave and call 911, in that order', () => {
    // MAINT-01 calls this out by name: "gas: call gas company & 911 first".
    const steps = EMERGENCY_DEFINITIONS.GAS_SMELL.selfProtection
    const joined = steps.join(' ').toLowerCase()
    expect(joined).toContain('leave')
    expect(joined).toContain('911')
    expect(joined).toContain('gas company')
    // Leaving comes before calling - a phone call from inside is the thing
    // to avoid.
    expect(steps[0]!.toLowerCase()).toContain('leave')
  })

  it('never sends a gas or CO reporter to find a shutoff', () => {
    // The single most important negative in this file. Hunting for a valve
    // is the wrong action for both, and showing one implies it is the right
    // one.
    expect(EMERGENCY_DEFINITIONS.GAS_SMELL.shutoffType).toBeNull()
    expect(EMERGENCY_DEFINITIONS.CO_ALARM.shutoffType).toBeNull()
  })

  it('warns the no-heat reporter about carbon monoxide', () => {
    // Heating a home with an oven or generator is the classic secondary
    // killer after a heating failure - the instructions have to pre-empt it.
    const joined = EMERGENCY_DEFINITIONS.NO_HEAT_FREEZING.selfProtection
      .join(' ')
      .toLowerCase()
    expect(joined).toContain('carbon monoxide')
    expect(joined).toContain('oven')
  })

  it('points flooding and sewage at the water main, electrical at the panel', () => {
    expect(EMERGENCY_DEFINITIONS.ACTIVE_FLOODING.shutoffType).toBe('WATER_MAIN')
    expect(EMERGENCY_DEFINITIONS.SEWAGE_BACKUP.shutoffType).toBe('WATER_MAIN')
    expect(EMERGENCY_DEFINITIONS.ELECTRICAL_BURNING.shutoffType).toBe('BREAKER_PANEL')
  })

  it('tells a break-in reporter to call 911 rather than the landlord first', () => {
    const joined = EMERGENCY_DEFINITIONS.BREAK_IN.selfProtection.join(' ')
    expect(joined).toContain('911')
  })
})

describe('emergencyDefinition', () => {
  it('resolves an emergency category and refuses an ordinary one', () => {
    expect(emergencyDefinition('GAS_SMELL')?.label).toBe('I smell gas')
    expect(emergencyDefinition('PLUMBING')).toBeUndefined()
    expect(emergencyDefinition('nonsense')).toBeUndefined()
  })
})

describe('validateEmergencyRequest', () => {
  const valid: EmergencyRequestInput = {
    category: 'ACTIVE_FLOODING',
    petWarning: false,
    entryPermission: true,
  }

  it('accepts a minimal submission with no free text at all', () => {
    // Deliberate: an emergency must never be gated on typing.
    expect(validateEmergencyRequest(valid)).toEqual([])
  })

  it('rejects an unknown category', () => {
    expect(
      validateEmergencyRequest({ ...valid, category: 'PLUMBING' }),
    ).toContainEqual(expect.objectContaining({ field: 'category' }))
  })

  it('still requires explicit entry and pet answers', () => {
    // Both are one tap and both matter to somebody opening a door at 2am -
    // and as everywhere else in this build, `undefined` is not `false`.
    expect(
      validateEmergencyRequest({ ...valid, entryPermission: undefined }),
    ).toContainEqual(expect.objectContaining({ field: 'entryPermission' }))
    expect(
      validateEmergencyRequest({ ...valid, petWarning: undefined }),
    ).toContainEqual(expect.objectContaining({ field: 'petWarning' }))
  })

  it('accepts an explicit no for both', () => {
    expect(
      validateEmergencyRequest({ ...valid, entryPermission: false, petWarning: false }),
    ).toEqual([])
  })
})

describe('formatEmergencyDescription', () => {
  it('leads with EMERGENCY and the tenant’s own words', () => {
    const text = formatEmergencyDescription('GAS_SMELL', {
      category: 'GAS_SMELL',
      petWarning: true,
      entryPermission: false,
    })
    expect(text.startsWith('EMERGENCY: I smell gas.')).toBe(true)
    expect(text).toContain('There is a pet at home.')
    expect(text).toContain('Entry NOT permitted unless the tenant is home.')
    // Evidence that the tenant was shown the instructions before submitting -
    // which matters in a later dispute about what they were told.
    expect(text).toContain('Safety instructions were shown')
  })

  it('includes optional detail when given and omits it when not', () => {
    const withDetail = formatEmergencyDescription('ACTIVE_FLOODING', {
      category: 'ACTIVE_FLOODING',
      detail: 'Water coming from under the dishwasher',
      petWarning: false,
      entryPermission: true,
    })
    expect(withDetail).toContain('Water coming from under the dishwasher')

    const withoutDetail = formatEmergencyDescription('ACTIVE_FLOODING', {
      category: 'ACTIVE_FLOODING',
      detail: '   ',
      petWarning: false,
      entryPermission: true,
    })
    expect(withoutDetail).not.toContain('undefined')
    expect(withoutDetail).toContain('No pet at home.')
  })
})
