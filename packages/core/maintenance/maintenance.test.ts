import { describe, expect, it } from 'vitest'
import {
  CLARIFYING_PROMPTS,
  FIRST_RESPONSE_SLA_HOURS,
  MAINTENANCE_CATEGORIES,
  type MaintenanceRequestInput,
  type PhoneLoggedRequestInput,
  applicableTroubleshootingSteps,
  canMergeTicket,
  detectHabitabilityLanguage,
  firstResponseSlaState,
  formatMaintenanceDescription,
  formatPhoneLoggedDescription,
  isMaintenanceCategory,
  isTicketTriageResolved,
  suggestTicketPriority,
  validateMaintenanceRequest,
  validatePhoneLoggedRequest,
} from './index.ts'

describe('the category vocabulary', () => {
  it('matches MAINT-01 exactly - seven categories', () => {
    expect(MAINTENANCE_CATEGORIES).toHaveLength(7)
    expect(isMaintenanceCategory('PLUMBING')).toBe(true)
    expect(isMaintenanceCategory('EMERGENCY')).toBe(false)
  })

  it('gives every category 2-3 clarifying prompts, per MAINT-01', () => {
    for (const category of MAINTENANCE_CATEGORIES) {
      const prompts = CLARIFYING_PROMPTS[category]
      expect(prompts.length, category).toBeGreaterThanOrEqual(2)
      expect(prompts.length, category).toBeLessThanOrEqual(3)
    }
  })
})

describe('applicableTroubleshootingSteps', () => {
  it('always shows the breaker and GFCI scripts for electrical', () => {
    const steps = applicableTroubleshootingSteps('ELECTRICAL', {})
    expect(steps.map((s) => s.id)).toEqual(['breaker', 'gfci'])
  })

  it('shows the disposal script only when the disposal was picked', () => {
    expect(
      applicableTroubleshootingSteps('APPLIANCE', { appliance: 'Garbage disposal' }).map(
        (s) => s.id,
      ),
    ).toEqual(['disposal_reset'])
    expect(
      applicableTroubleshootingSteps('APPLIANCE', { appliance: 'Refrigerator' }),
    ).toEqual([])
  })

  it('shows the toilet flapper script only for a toilet', () => {
    expect(
      applicableTroubleshootingSteps('PLUMBING', { where: 'Toilet' }).map((s) => s.id),
    ).toEqual(['flapper'])
    expect(applicableTroubleshootingSteps('PLUMBING', { where: 'Kitchen sink' })).toEqual([])
  })

  it('narrows HVAC scripts to what the system answer supports', () => {
    // Cooling: only the thermostat battery makes sense - a furnace switch or
    // pilot light script would be actively unhelpful advice.
    expect(
      applicableTroubleshootingSteps('HVAC', { system: 'Cooling' }).map((s) => s.id),
    ).toEqual(['thermostat_battery'])
    // Heating: all three named in the backlog apply.
    expect(
      applicableTroubleshootingSteps('HVAC', { system: 'Heating' }).map((s) => s.id),
    ).toEqual(['thermostat_battery', 'furnace_switch', 'pilot_light'])
  })

  it('has no script for categories the backlog names none for', () => {
    expect(applicableTroubleshootingSteps('PEST', {})).toEqual([])
    expect(applicableTroubleshootingSteps('EXTERIOR', {})).toEqual([])
    expect(applicableTroubleshootingSteps('LOCKS', {})).toEqual([])
  })
})

describe('detectHabitabilityLanguage', () => {
  it('flags each of the five named keywords', () => {
    expect(detectHabitabilityLanguage('There is mold on the ceiling')).toBe(true)
    expect(detectHabitabilityLanguage('Water is leaking from the ceiling')).toBe(true)
    expect(detectHabitabilityLanguage('We have no heat and it is freezing')).toBe(true)
    expect(detectHabitabilityLanguage('Sewage is backing up in the tub')).toBe(true)
    expect(detectHabitabilityLanguage('There is a roach infestation')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(detectHabitabilityLanguage('MOLD everywhere')).toBe(true)
  })

  it('does not flag ordinary requests', () => {
    expect(detectHabitabilityLanguage('The garbage disposal is jammed')).toBe(false)
  })
})

describe('validateMaintenanceRequest', () => {
  const validElectrical: MaintenanceRequestInput = {
    category: 'ELECTRICAL',
    promptAnswers: { what: 'One outlet', extent: 'One room' },
    troubleshooting: { breaker: 'TRIED', gfci: 'DECLINED' },
    entryPermission: true,
    petWarning: false,
  }

  it('accepts a fully-answered submission', () => {
    expect(validateMaintenanceRequest(validElectrical)).toEqual([])
  })

  it('rejects an unknown category', () => {
    expect(
      validateMaintenanceRequest({ ...validElectrical, category: 'ROOF' }),
    ).toContainEqual(expect.objectContaining({ field: 'category' }))
  })

  it('rejects a missing clarifying-prompt answer', () => {
    expect(
      validateMaintenanceRequest({
        ...validElectrical,
        promptAnswers: { what: 'One outlet' },
      }),
    ).toContainEqual(expect.objectContaining({ field: 'prompt.extent' }))
  })

  it('rejects a select answer that is not one of the offered options', () => {
    expect(
      validateMaintenanceRequest({
        ...validElectrical,
        promptAnswers: { ...validElectrical.promptAnswers, extent: 'Something else' },
      }),
    ).toContainEqual(expect.objectContaining({ field: 'prompt.extent' }))
  })

  it('THE GATE: refuses to submit when an applicable troubleshooting step has no tried/declined answer', () => {
    // MAINT-01, verbatim: "logging tried/declined before dispatch is
    // allowed." This is that gate.
    expect(
      validateMaintenanceRequest({ ...validElectrical, troubleshooting: { breaker: 'TRIED' } }),
    ).toContainEqual(expect.objectContaining({ field: 'troubleshooting.gfci' }))
  })

  it('does not require an answer for a step that does not apply', () => {
    // Appliance/refrigerator has no applicable script at all - nothing to log.
    expect(
      validateMaintenanceRequest({
        category: 'APPLIANCE',
        promptAnswers: { appliance: 'Refrigerator', symptom: 'making noise' },
        troubleshooting: {},
        entryPermission: true,
        petWarning: false,
      }),
    ).toEqual([])
  })

  it('requires an explicit entry-permission answer, not a default', () => {
    expect(
      validateMaintenanceRequest({ ...validElectrical, entryPermission: undefined }),
    ).toContainEqual(expect.objectContaining({ field: 'entryPermission' }))
  })

  it('accepts an explicit "no" for entry permission - false is a real answer', () => {
    expect(validateMaintenanceRequest({ ...validElectrical, entryPermission: false })).toEqual(
      [],
    )
  })

  it('requires an explicit pet-warning answer, not a default', () => {
    expect(
      validateMaintenanceRequest({ ...validElectrical, petWarning: undefined }),
    ).toContainEqual(expect.objectContaining({ field: 'petWarning' }))
  })
})

describe('formatMaintenanceDescription', () => {
  it('produces a readable transcript in the order things were asked', () => {
    const input: MaintenanceRequestInput = {
      category: 'PLUMBING',
      promptAnswers: { where: 'Toilet', leaking_now: 'No', only_toilet: 'Yes' },
      troubleshooting: { flapper: 'TRIED' },
      entryPermission: true,
      petWarning: true,
      petNote: 'friendly dog',
    }
    const text = formatMaintenanceDescription('PLUMBING', input)

    expect(text).toContain('Plumbing issue.')
    expect(text).toContain('Where is the problem? Toilet')
    expect(text).toContain('Check the toilet flapper: Tried this - did not fix it.')
    expect(text).toContain('friendly dog')
    expect(text).toContain('Entry permitted if the tenant is not home.')
  })

  it('says entry is not permitted when the tenant said no', () => {
    const text = formatMaintenanceDescription('LOCKS', {
      category: 'LOCKS',
      promptAnswers: { what: "Won't lock", which_door: 'Front door' },
      troubleshooting: {},
      entryPermission: false,
      petWarning: false,
    })
    expect(text).toContain('Entry NOT permitted unless the tenant is home.')
  })

  it('omits the pet line entirely when there is no pet', () => {
    const text = formatMaintenanceDescription('LOCKS', {
      category: 'LOCKS',
      promptAnswers: { what: "Won't lock", which_door: 'Front door' },
      troubleshooting: {},
      entryPermission: true,
      petWarning: false,
    })
    expect(text).not.toContain('pet')
  })
})

describe('validatePhoneLoggedRequest', () => {
  const valid: PhoneLoggedRequestInput = {
    category: 'PLUMBING',
    notes: 'Tenant says the kitchen faucet drips constantly.',
    entryPermission: true,
    petWarning: false,
  }

  it('accepts a complete submission', () => {
    expect(validatePhoneLoggedRequest(valid)).toEqual([])
  })

  it('rejects an unrecognized category', () => {
    const violations = validatePhoneLoggedRequest({ ...valid, category: 'NOT_REAL' })
    expect(violations.map((v) => v.field)).toContain('category')
  })

  it('rejects empty or whitespace-only notes', () => {
    expect(
      validatePhoneLoggedRequest({ ...valid, notes: '   ' }).map((v) => v.field),
    ).toContain('notes')
  })

  it('requires a real answer for entry permission and pet warning, not a default', () => {
    const violations = validatePhoneLoggedRequest({
      ...valid,
      entryPermission: undefined,
      petWarning: undefined,
    })
    expect(violations.map((v) => v.field)).toEqual(
      expect.arrayContaining(['entryPermission', 'petWarning']),
    )
  })

  it('does NOT require clarifying prompts or troubleshooting - unlike the tenant path', () => {
    // A staff phone-log submission has no prompts/troubleshooting keys at
    // all, and that must still validate cleanly.
    expect(validatePhoneLoggedRequest(valid)).toEqual([])
  })
})

describe('formatPhoneLoggedDescription', () => {
  it('leads with the category and the staff-written notes', () => {
    const text = formatPhoneLoggedDescription('PLUMBING', {
      category: 'PLUMBING',
      notes: 'Kitchen faucet drips constantly, worse at night.',
      entryPermission: true,
      petWarning: false,
    })
    expect(text).toContain('Plumbing issue, reported by phone.')
    expect(text).toContain('Kitchen faucet drips constantly, worse at night.')
    expect(text).toContain('Entry permitted if the tenant is not home.')
  })

  it('includes the pet note when given, and omits the pet line when there is none', () => {
    const withPet = formatPhoneLoggedDescription('LOCKS', {
      category: 'LOCKS',
      notes: "Front door won't lock.",
      entryPermission: false,
      petWarning: true,
      petNote: 'Friendly dog, does not need to be secured.',
    })
    expect(withPet).toContain('There is a pet at home: Friendly dog')
    expect(withPet).toContain('Entry NOT permitted unless the tenant is home.')

    const withoutPet = formatPhoneLoggedDescription('LOCKS', {
      category: 'LOCKS',
      notes: "Front door won't lock.",
      entryPermission: false,
      petWarning: false,
    })
    expect(withoutPet).not.toContain('pet')
  })
})

describe('suggestTicketPriority', () => {
  it('suggests URGENT for categories where delay carries real cost', () => {
    for (const category of ['PLUMBING', 'ELECTRICAL', 'HVAC', 'LOCKS']) {
      expect(
        suggestTicketPriority({ category, habitabilityFlag: false }),
        category,
      ).toBe('URGENT')
    }
  })

  it('suggests ROUTINE for the rest', () => {
    for (const category of ['APPLIANCE', 'PEST', 'EXTERIOR']) {
      expect(
        suggestTicketPriority({ category, habitabilityFlag: false }),
        category,
      ).toBe('ROUTINE')
    }
  })

  it('habitability language overrides the category default outright', () => {
    // PEST is ROUTINE by default, but an infestation is not routine.
    expect(
      suggestTicketPriority({ category: 'PEST', habitabilityFlag: true }),
    ).toBe('URGENT')
  })

  it('falls through UNCATEGORIZED (SMS tickets, R-021) to ROUTINE', () => {
    expect(
      suggestTicketPriority({ category: 'UNCATEGORIZED', habitabilityFlag: false }),
    ).toBe('ROUTINE')
  })

  it('never suggests EMERGENCY - that is earned only through R-020s own intake', () => {
    for (const category of MAINTENANCE_CATEGORIES) {
      expect(
        suggestTicketPriority({ category, habitabilityFlag: true }),
      ).not.toBe('EMERGENCY')
    }
  })
})

describe('firstResponseSlaState', () => {
  const createdAt = new Date('2026-08-05T12:00:00Z')

  it('is on_track well within the window', () => {
    const now = new Date('2026-08-05T12:30:00Z')
    expect(firstResponseSlaState({ createdAt, firstResponseAt: null }, now)).toBe(
      'on_track',
    )
  })

  it('is approaching once past the warning fraction of the window', () => {
    const now = new Date(
      createdAt.getTime() + FIRST_RESPONSE_SLA_HOURS * 0.8 * 3_600_000,
    )
    expect(firstResponseSlaState({ createdAt, firstResponseAt: null }, now)).toBe(
      'approaching',
    )
  })

  it('is breached once the window has fully elapsed', () => {
    const now = new Date(createdAt.getTime() + (FIRST_RESPONSE_SLA_HOURS + 1) * 3_600_000)
    expect(firstResponseSlaState({ createdAt, firstResponseAt: null }, now)).toBe(
      'breached',
    )
  })

  it('is responded once firstResponseAt is set, even long after the window', () => {
    const now = new Date(createdAt.getTime() + 100 * 3_600_000)
    const firstResponseAt = new Date(createdAt.getTime() + 99 * 3_600_000)
    expect(firstResponseSlaState({ createdAt, firstResponseAt }, now)).toBe('responded')
  })
})

describe('canMergeTicket', () => {
  const base = { propertyId: 'prop_1', status: 'NEW' }

  it('accepts merging one open ticket into another at the same property', () => {
    expect(
      canMergeTicket({ id: 't1', ...base }, { id: 't2', ...base, status: 'TRIAGED' }),
    ).toEqual([])
  })

  it('refuses merging a ticket into itself', () => {
    const violations = canMergeTicket({ id: 't1', ...base }, { id: 't1', ...base })
    expect(violations.map((v) => v.field)).toContain('targetTicketId')
  })

  it('refuses merging across properties', () => {
    const violations = canMergeTicket(
      { id: 't1', propertyId: 'prop_1', status: 'NEW' },
      { id: 't2', propertyId: 'prop_2', status: 'NEW' },
    )
    expect(violations.map((v) => v.field)).toContain('targetTicketId')
  })

  it('refuses a source ticket whose own triage is already resolved', () => {
    // Not just MERGED/CLOSED - WAITING_ON_TENANT and CONVERTED are also a
    // completed triage decision (their own Task is already DONE), so the
    // source side refuses all four the same way resolveTicketTriage's own
    // guard does.
    for (const status of ['WAITING_ON_TENANT', 'CONVERTED', 'MERGED', 'CLOSED']) {
      const violations = canMergeTicket(
        { id: 't1', ...base, status },
        { id: 't2', ...base },
      )
      expect(violations.length, status).toBeGreaterThan(0)
    }
  })

  it('accepts a target that has moved past initial triage but is not MERGED or CLOSED', () => {
    // A duplicate discovered after the original already moved to
    // WAITING_ON_TENANT or CONVERTED is still the same problem.
    for (const status of ['WAITING_ON_TENANT', 'CONVERTED']) {
      expect(
        canMergeTicket({ id: 't1', ...base }, { id: 't2', ...base, status }),
        status,
      ).toEqual([])
    }
  })

  it('refuses a target ticket that is not open', () => {
    for (const status of ['MERGED', 'CLOSED']) {
      const violations = canMergeTicket(
        { id: 't1', ...base },
        { id: 't2', ...base, status },
      )
      expect(violations.length, status).toBeGreaterThan(0)
    }
  })
})

describe('isTicketTriageResolved', () => {
  it('is true for every terminal triage outcome', () => {
    for (const status of ['WAITING_ON_TENANT', 'CONVERTED', 'MERGED', 'CLOSED']) {
      expect(isTicketTriageResolved(status), status).toBe(true)
    }
  })

  it('is false while a triage decision has not yet been made', () => {
    for (const status of ['NEW', 'TRIAGED']) {
      expect(isTicketTriageResolved(status), status).toBe(false)
    }
  })
})
