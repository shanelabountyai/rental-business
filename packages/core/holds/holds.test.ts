import { describe, expect, it } from 'vitest'
import {
  effectsInForce,
  HOLD_DEFINITIONS,
  HOLD_EFFECTS,
  HOLD_TYPES,
  holdsCausing,
  isHalted,
  isHoldType,
  liftIsPrivileged,
  type PlacedHold,
} from './index.ts'

const active = (type: PlacedHold['type']): PlacedHold => ({ type, liftedAt: null })
const lifted = (type: PlacedHold['type']): PlacedHold => ({ type, liftedAt: new Date() })

describe('the effect table itself', () => {
  it('declares effects for every type', () => {
    for (const type of HOLD_TYPES) {
      expect(HOLD_DEFINITIONS[type].effects.length).toBeGreaterThan(0)
      expect(HOLD_DEFINITIONS[type].banner.length).toBeGreaterThan(0)
    }
  })

  // The guard against a vocabulary that outgrows its guards: an effect no
  // type claims is one nothing can ever switch on, which reads as a feature
  // and is a dead string.
  it('has at least one type claiming every effect', () => {
    for (const effect of HOLD_EFFECTS) {
      expect(HOLD_TYPES.some((type) => HOLD_DEFINITIONS[type].effects.includes(effect))).toBe(true)
    }
  })

  it('rejects a type it does not know', () => {
    expect(isHoldType('military_scra')).toBe(true)
    expect(isHoldType('eviction')).toBe(false)
  })
})

describe('effectsInForce', () => {
  it('is empty with no holds', () => {
    expect([...effectsInForce([])]).toEqual([])
  })

  it('unions two holds rather than intersecting them', () => {
    // `do_not_contact` does NOT halt late fees; `payment_plan` does. Together
    // the tenancy gets both consequences.
    const both = effectsInForce([active('do_not_contact'), active('payment_plan')])
    expect(both.has('halt_late_fees')).toBe(true)
    expect(both.has('suppress_marketing')).toBe(true)
    expect(both.has('halt_dunning')).toBe(true)
  })

  it('ignores a lifted hold', () => {
    expect(effectsInForce([lifted('bankruptcy')]).size).toBe(0)
    expect(isHalted([lifted('bankruptcy')], 'halt_late_fees')).toBe(false)
  })
})

describe('the asymmetry do_not_contact encodes', () => {
  // Named as its own test because it is the one line of this table somebody
  // will read as a bug: asking not to be contacted is not asking to be
  // forgiven, so the meter keeps running while the messages stop.
  it('stops the chase without stopping the late fees', () => {
    const holds = [active('do_not_contact')]
    expect(isHalted(holds, 'halt_dunning')).toBe(true)
    expect(isHalted(holds, 'suppress_marketing')).toBe(true)
    expect(isHalted(holds, 'halt_late_fees')).toBe(false)
  })
})

describe('holdsCausing', () => {
  it('names which hold stopped it, so a skip can be attributed', () => {
    const holds = [active('bankruptcy'), active('do_not_contact'), lifted('dispute')]
    expect(holdsCausing(holds, 'halt_late_fees')).toEqual(['bankruptcy'])
    expect(holdsCausing(holds, 'halt_dunning')).toEqual(['bankruptcy', 'do_not_contact'])
    expect(holdsCausing(holds, 'halt_access_changes')).toEqual(['bankruptcy'])
  })
})

describe('privileged lifts', () => {
  it('covers the three where lifting is itself a legal judgement', () => {
    expect(liftIsPrivileged('military_scra')).toBe(true)
    expect(liftIsPrivileged('deceased')).toBe(true)
    expect(liftIsPrivileged('bankruptcy')).toBe(true)
    expect(liftIsPrivileged('dispute')).toBe(false)
    expect(liftIsPrivileged('payment_plan')).toBe(false)
    expect(liftIsPrivileged('do_not_contact')).toBe(false)
  })
})
