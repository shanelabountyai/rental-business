import { describe, expect, it } from 'vitest'

import {
  ANIMAL_FORK_MESSAGES,
  LEGITIMIZATION_ROUTES,
  VIOLATION_GROUNDS,
  VIOLATION_GROUND_LABELS,
  VIOLATION_KINDS,
  animalCaseFork,
  isViolationGround,
  validateClosure,
  validateObservation,
  type ClosureFacts,
  type ObservationInput,
} from './index.ts'

const TODAY = '2026-08-23'

function observation(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    kind: 'PREMISES_CONDITION',
    ground: 'BLOCKED_EGRESS',
    observedOn: '2026-08-20',
    note: 'Rear bedroom window blocked to the sill by stacked boxes; sash cannot open.',
    ...overrides,
  }
}

function closure(overrides: Partial<ClosureFacts> = {}): ClosureFacts {
  return {
    kind: 'UNAUTHORIZED_OCCUPANT',
    outcome: 'CURED',
    outcomeNote: 'The second adult moved out on 12 August and the unit was re-inspected on the 14th.',
    legitimizedApplicantId: null,
    legitimizedApplicantScreened: false,
    authorizedAnimal: null,
    approvedAccommodationId: null,
    hasUndecidedRequest: false,
    overrideReason: null,
    ...overrides,
  }
}

describe('the vocabulary contains nothing about a person', () => {
  // The load-bearing test for this whole module. RISK-03 asks for a notice
  // series targeting lease and safety terms "never the person", and the
  // closed ground list is the only thing enforcing that. A later session
  // adding `HOARDING`, `POOR_HOUSEKEEPING` or `CLUTTER` to either enum should
  // land here before it lands in a notice somebody serves.
  const FORBIDDEN = ['HOARD', 'CLUTTER', 'HOUSEKEEP', 'FILTH', 'SQUALOR', 'DIRTY', 'MENTAL', 'TENANT']

  it('has no violation kind naming a person or a condition of one', () => {
    for (const kind of VIOLATION_KINDS) {
      for (const word of FORBIDDEN) expect(kind).not.toContain(word)
    }
  })

  it('has no ground naming a person or a condition of one, in the enum or its label', () => {
    for (const ground of VIOLATION_GROUNDS) {
      for (const word of FORBIDDEN) {
        expect(ground).not.toContain(word)
        expect(VIOLATION_GROUND_LABELS[ground].toUpperCase()).not.toContain(word)
      }
    }
  })

  it('rejects a ground it does not know, so free text cannot arrive as one', () => {
    expect(isViolationGround('HOARDING')).toBe(false)
    expect(isViolationGround('BLOCKED_EGRESS')).toBe(true)
  })
})

describe('validateObservation', () => {
  it('accepts a condition observation naming a ground', () => {
    expect(validateObservation(observation(), TODAY)).toEqual([])
  })

  it('refuses a condition observation with no ground', () => {
    const errors = validateObservation(observation({ ground: null }), TODAY)
    expect(errors.map((e) => e.field)).toContain('ground')
  })

  it('refuses a ground on an occupant case, where the kind is already the ground', () => {
    const errors = validateObservation(
      observation({ kind: 'UNAUTHORIZED_OCCUPANT', ground: 'SANITATION' }),
      TODAY,
    )
    expect(errors.map((e) => e.field)).toContain('ground')
  })

  it('accepts an occupant observation with no ground', () => {
    expect(
      validateObservation(observation({ kind: 'UNAUTHORIZED_OCCUPANT', ground: null }), TODAY),
    ).toEqual([])
  })

  it('refuses an observation dated in the future', () => {
    const errors = validateObservation(observation({ observedOn: '2026-09-01' }), TODAY)
    expect(errors.map((e) => e.field)).toContain('observedOn')
  })

  it('refuses an observation with nothing written down', () => {
    const errors = validateObservation(observation({ note: 'bad' }), TODAY)
    expect(errors.map((e) => e.field)).toContain('note')
  })
})

describe('animalCaseFork', () => {
  it('reports an approved assistance animal ahead of anything else', () => {
    expect(
      animalCaseFork({ hasApprovedAssistanceAnimal: true, hasUndecidedRequest: true }),
    ).toBe('already_approved')
  })

  it('reports an undecided request when there is no approval', () => {
    expect(
      animalCaseFork({ hasApprovedAssistanceAnimal: false, hasUndecidedRequest: true }),
    ).toBe('request_undecided')
  })

  it('still says to ask when there is nothing on file', () => {
    const fork = animalCaseFork({ hasApprovedAssistanceAnimal: false, hasUndecidedRequest: false })
    expect(fork).toBe('ask_first')
    expect(ANIMAL_FORK_MESSAGES[fork]).toContain('assistance animal')
  })
})

describe('validateClosure', () => {
  it('needs an account of how the case ended, whatever the outcome', () => {
    const { violations } = validateClosure(closure({ outcomeNote: 'done' }))
    expect(violations.map((v) => v.field)).toContain('outcomeNote')
  })

  describe('legitimizing an occupant', () => {
    it('refuses without an application', () => {
      const { violations } = validateClosure(closure({ outcome: 'LEGITIMIZED' }))
      expect(violations.map((v) => v.field)).toContain('legitimizedApplicantId')
    })

    it('refuses an application that was never screened — equal treatment is the whole point', () => {
      const { violations } = validateClosure(
        closure({
          outcome: 'LEGITIMIZED',
          legitimizedApplicantId: 'appl_1',
          legitimizedApplicantScreened: false,
        }),
      )
      expect(violations.map((v) => v.field)).toContain('legitimizedApplicantId')
    })

    it('accepts a screened applicant', () => {
      const { violations } = validateClosure(
        closure({
          outcome: 'LEGITIMIZED',
          legitimizedApplicantId: 'appl_1',
          legitimizedApplicantScreened: true,
        }),
      )
      expect(violations).toEqual([])
    })
  })

  describe('legitimizing an animal', () => {
    const animal = (overrides: Partial<ClosureFacts> = {}) =>
      closure({
        kind: 'UNAUTHORIZED_ANIMAL',
        outcome: 'LEGITIMIZED',
        authorizedAnimal: 'One adult tabby cat, "Mouse"',
        ...overrides,
      })

    it('accepts a named animal with nothing pending', () => {
      expect(validateClosure(animal()).violations).toEqual([])
    })

    it('refuses an unnamed animal', () => {
      const { violations } = validateClosure(animal({ authorizedAnimal: null }))
      expect(violations.map((v) => v.field)).toContain('authorizedAnimal')
    })

    // THE ONE HARD REFUSAL. Recording an animal as an authorized pet while an
    // accommodation request on the same tenancy is undecided answers that
    // request, in the direction that costs the tenant money, before anybody
    // has decided it. Unlike every other warning here it has a workaround that
    // is not "destroy the record": go and decide the request, which was owed
    // within ten days anyway (D-89).
    it('refuses while an accommodation request on the tenancy is undecided', () => {
      const { violations } = validateClosure(animal({ hasUndecidedRequest: true }))
      expect(violations.map((v) => v.field)).toContain('outcome')
    })
  })

  it('refuses to legitimize a premises condition at all', () => {
    const { violations } = validateClosure(
      closure({ kind: 'PREMISES_CONDITION', outcome: 'LEGITIMIZED' }),
    )
    expect(violations.map((v) => v.field)).toContain('outcome')
    expect(LEGITIMIZATION_ROUTES.PREMISES_CONDITION.available).toBe(false)
  })

  it('refuses to close as accommodated with no approved request on file', () => {
    const { violations } = validateClosure(
      closure({ kind: 'PREMISES_CONDITION', outcome: 'ACCOMMODATED' }),
    )
    expect(violations.map((v) => v.field)).toContain('outcome')
  })

  describe('escalating', () => {
    // Warns and demands a reason rather than blocking, the posture D-79 sets
    // out: escalating is sometimes entirely lawful with a request open, and a
    // block would push the operator into closing the request to get past it.
    it('demands a reason when a request is undecided', () => {
      const { violations } = validateClosure(
        closure({ outcome: 'ESCALATED', hasUndecidedRequest: true }),
      )
      expect(violations.map((v) => v.field)).toContain('overrideReason')
    })

    it('lets it through with a reason, and still says the request is owed', () => {
      const { violations, warnings } = validateClosure(
        closure({
          outcome: 'ESCALATED',
          hasUndecidedRequest: true,
          overrideReason: 'Two further blocked-egress observations after the accommodation meeting.',
        }),
      )
      expect(violations).toEqual([])
      expect(warnings.join(' ')).toContain('still owed')
    })

    it('warns without demanding a reason when an accommodation was approved', () => {
      const { violations, warnings } = validateClosure(
        closure({ outcome: 'ESCALATED', approvedAccommodationId: 'acc_1' }),
      )
      expect(violations).toEqual([])
      expect(warnings).toHaveLength(1)
    })
  })
})
