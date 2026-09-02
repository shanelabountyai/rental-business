import { describe, expect, it } from 'vitest'
import {
  ACCOMMODATION_KINDS,
  ACCOMMODATION_KIND_LABELS,
  clockSummary,
  documentationRequestable,
  LAWFUL_DENIAL_GROUNDS,
  PET_MONEY_TYPES,
  petMoneyAllowed,
  REQUEST_STATUSES,
  RESPONSE_TARGET_DAYS,
  responseClock,
  validateDetermination,
} from './index.ts'

describe('what may lawfully be asked', () => {
  // The mistake this function exists to prevent: asking a service-animal
  // handler for a letter is itself the violation, whatever the answer.
  it('never permits documentation for a service animal, however non-obvious', () => {
    const decision = documentationRequestable({
      kind: 'SERVICE_ANIMAL',
      disabilityObservable: false,
      needObservable: false,
    })
    expect(decision.requestable).toBe(false)
    expect(decision.refusal).toBe('service_animal')
  })

  it('refuses when the DISABILITY is observable', () => {
    const decision = documentationRequestable({
      kind: 'ASSISTANCE_ANIMAL',
      disabilityObservable: true,
      needObservable: false,
    })
    expect(decision.requestable).toBe(false)
    expect(decision.refusal).toBe('observable')
  })

  it('refuses when the NEED is observable, even if the disability is not', () => {
    // Two separate observations, and either one closes the question. A dog
    // visibly retrieving dropped items establishes the need without the
    // handler's condition being apparent at all.
    const decision = documentationRequestable({
      kind: 'ASSISTANCE_ANIMAL',
      disabilityObservable: false,
      needObservable: true,
    })
    expect(decision.requestable).toBe(false)
    expect(decision.refusal).toBe('observable')
  })

  it('permits it only for a non-obvious assistance-animal request', () => {
    expect(
      documentationRequestable({
        kind: 'ASSISTANCE_ANIMAL',
        disabilityObservable: false,
        needObservable: false,
      }),
    ).toEqual({ requestable: true })
  })

  it('lets a policy exception be documented on the general rule, with no ADA carve-out', () => {
    // R-088 widened this beyond animals. The ADA two-question limit is the
    // one genuinely animal-shaped rule in here, so it must NOT fire on a
    // policy exception - but the observability rule still must.
    expect(
      documentationRequestable({
        kind: 'POLICY_EXCEPTION',
        disabilityObservable: false,
        needObservable: false,
      }),
    ).toEqual({ requestable: true })
    expect(
      documentationRequestable({
        kind: 'POLICY_EXCEPTION',
        disabilityObservable: true,
        needObservable: false,
      }),
    ).toEqual({ requestable: false, refusal: 'observable' })
  })

  it('has a label for every kind', () => {
    expect(ACCOMMODATION_KINDS).toHaveLength(3)
    for (const kind of ACCOMMODATION_KINDS) {
      expect(ACCOMMODATION_KIND_LABELS[kind].length).toBeGreaterThan(0)
    }
  })
})

describe('pet money', () => {

  it('is refused outright once an assistance animal is approved', () => {
    expect(petMoneyAllowed(true)).toBe(false)
    expect(petMoneyAllowed(false)).toBe(true)
  })
})

describe('the response clock', () => {
  it('counts days outstanding while undecided', () => {
    const clock = responseClock('2026-08-01', null, '2026-08-06')
    expect(clock.daysOutstanding).toBe(5)
    expect(clock.daysRemaining).toBe(5)
    expect(clock.overdue).toBe(false)
    expect(clock.decided).toBe(false)
  })

  it('is not overdue ON the tenth day', () => {
    const clock = responseClock('2026-08-01', null, '2026-08-11')
    expect(clock.daysOutstanding).toBe(RESPONSE_TARGET_DAYS)
    expect(clock.overdue).toBe(false)
  })

  it('goes overdue on the eleventh', () => {
    const clock = responseClock('2026-08-01', null, '2026-08-12')
    expect(clock.overdue).toBe(true)
    expect(clock.daysRemaining).toBe(-1)
    expect(clockSummary(clock)).toMatch(/reads as a denial/)
  })

  it('measures a decided request to its decision date, not to today', () => {
    const clock = responseClock('2026-08-01', '2026-08-04', '2026-12-01')
    expect(clock.daysOutstanding).toBe(3)
    expect(clock.decided).toBe(true)
    expect(clock.daysRemaining).toBeNull()
    expect(clock.overdue).toBe(false)
  })

  it('still reports a LATE decision as overdue after the fact', () => {
    // The record has to keep saying it took too long. A decided-but-late
    // request that reported itself fine would erase the only evidence of the
    // delay.
    const clock = responseClock('2026-08-01', '2026-09-01', '2026-12-01')
    expect(clock.decided).toBe(true)
    expect(clock.overdue).toBe(true)
  })
})

describe('the written determination', () => {
  it('refuses a denial with no stated basis', () => {
    const violations = validateDetermination({
      outcome: 'DENIED',
      determinationText: 'no',
      subjectDescription: '',
      kind: 'ASSISTANCE_ANIMAL',
    })
    expect(violations.map((v) => v.field)).toContain('determinationText')
    expect(violations[0]!.message).toMatch(/discriminatory/)
  })

  it('refuses an APPROVAL with no written text either', () => {
    // Both outcomes, not just denials: an approval with no record of what
    // was approved is what produces "we never agreed to the second dog".
    const violations = validateDetermination({
      outcome: 'APPROVED',
      determinationText: 'ok',
      subjectDescription: 'Bella, a labrador',
      kind: 'ASSISTANCE_ANIMAL',
    })
    expect(violations.map((v) => v.field)).toEqual(['determinationText'])
  })

  it('refuses an approval that does not say which animal', () => {
    const violations = validateDetermination({
      outcome: 'APPROVED',
      determinationText: 'Approved as an assistance animal under the FHA; no pet charges apply.',
      subjectDescription: '',
      kind: 'ASSISTANCE_ANIMAL',
    })
    expect(violations.map((v) => v.field)).toEqual(['subjectDescription'])
  })

  it('accepts a properly written approval', () => {
    expect(
      validateDetermination({
        outcome: 'APPROVED',
        determinationText:
          'Approved as an assistance animal under the FHA; no pet rent, fee or deposit applies.',
        subjectDescription: 'Bella, a labrador retriever',
        kind: 'ASSISTANCE_ANIMAL',
      }),
    ).toEqual([])
  })

  it('offers lawful denial grounds as prose, not as a picklist', () => {
    // Every one of these is a sentence somebody has to adapt, deliberately.
    // A dropdown of denial reasons becomes a dropdown of things it is safe
    // to say.
    expect(LAWFUL_DENIAL_GROUNDS.length).toBeGreaterThan(3)
    for (const ground of LAWFUL_DENIAL_GROUNDS) expect(ground.length).toBeGreaterThan(40)
  })
})
