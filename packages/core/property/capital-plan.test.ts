import { describe, expect, it } from 'vitest'
import {
  CAPITAL_COMPONENTS,
  type PlanPropertyFacts,
  annualAccrualCents,
  capitalPlanForProperty,
  dueWithinCents,
  reserveStatus,
} from './capital-plan.ts'
import { validatePropertyReserve } from './validate.ts'

function property(overrides: Partial<PlanPropertyFacts> = {}): PlanPropertyFacts {
  return {
    propertyId: 'prop_oak',
    propertyName: '114 Oak St',
    yearBuilt: 1996,
    units: [{ id: 'unit_1', label: '114 Oak St' }],
    improvements: [],
    appliances: [],
    ...overrides,
  }
}

const rowFor = (rows: ReturnType<typeof capitalPlanForProperty>, component: string) =>
  rows.find((row) => row.component === component)!

describe('capitalPlanForProperty', () => {
  it('falls back to year built, and says so', () => {
    const roof = rowFor(capitalPlanForProperty(property(), 2026), 'ROOF')
    expect(roof.ageSource).toBe('assumed_original')
    expect(roof.installedYear).toBe(1996)
    expect(roof.ageYears).toBe(30)
    expect(roof.dueYear).toBe(2021)
    // Overdue reads negative rather than clamping to zero: five years past is
    // a different budgeting problem from due this year.
    expect(roof.yearsRemaining).toBe(-5)
    expect(roof.costSource).toBe('default')
  })

  it('reports unknown rather than guessing when nothing dates a component', () => {
    const roof = rowFor(capitalPlanForProperty(property({ yearBuilt: null }), 2026), 'ROOF')
    expect(roof.ageSource).toBe('unknown')
    expect(roof.installedYear).toBeNull()
    expect(roof.dueYear).toBeNull()
    expect(roof.yearsRemaining).toBeNull()
    // The point of the whole fallback chain: an undated component contributes
    // nothing to the reserve figure an owner acts on.
    expect(roof.annualAccrualCents).toBe(0)
  })

  it('lets a recorded replacement reset the clock and the cost', () => {
    const rows = capitalPlanForProperty(
      property({
        improvements: [
          { category: 'ROOF', inServiceOn: '2004-06-01', costCents: 700_000 },
          { category: 'ROOF', inServiceOn: '2021-09-14', costCents: 1_850_000 },
        ],
      }),
      2026,
    )
    const roof = rowFor(rows, 'ROOF')
    expect(roof.ageSource).toBe('improvement')
    // The 2021 roof, not the 2004 one - otherwise the plan permanently
    // recommends work already done.
    expect(roof.installedYear).toBe(2021)
    expect(roof.dueYear).toBe(2046)
    // What this owner actually paid on this house beats the national default.
    expect(roof.costSource).toBe('recorded')
    expect(roof.estimatedCostCents).toBe(1_850_000)
    expect(roof.annualAccrualCents).toBe(Math.round(1_850_000 / 25))
  })

  it('prefers a dated appliance on the unit over the building’s age', () => {
    const rows = capitalPlanForProperty(
      property({
        appliances: [{ unitId: 'unit_1', category: 'WATER_HEATER', installedOn: '2019-02-20' }],
      }),
      2026,
    )
    const heater = rowFor(rows, 'WATER_HEATER')
    expect(heater.ageSource).toBe('appliance')
    expect(heater.installedYear).toBe(2019)
    expect(heater.dueYear).toBe(2031)
    expect(heater.unitId).toBe('unit_1')
  })

  // A duplex has one roof and two furnaces. Getting the scope wrong halves or
  // doubles the reserve, which is the number the whole feature exists for.
  it('projects unit-scoped components per unit and property-scoped ones once', () => {
    const rows = capitalPlanForProperty(
      property({
        units: [
          { id: 'unit_a', label: 'A' },
          { id: 'unit_b', label: 'B' },
        ],
        appliances: [{ unitId: 'unit_a', category: 'HVAC', installedOn: '2015-05-01' }],
      }),
      2026,
    )
    expect(rows.filter((row) => row.component === 'ROOF')).toHaveLength(1)
    const hvac = rows.filter((row) => row.component === 'HVAC')
    expect(hvac).toHaveLength(2)
    expect(hvac.find((row) => row.unitId === 'unit_a')!.ageSource).toBe('appliance')
    expect(hvac.find((row) => row.unitId === 'unit_b')!.ageSource).toBe('assumed_original')
  })

  it('sorts soonest first and undated last', () => {
    const rows = capitalPlanForProperty(property({ yearBuilt: 2020 }), 2026)
    const due = rows.map((row) => row.dueYear)
    expect(due).toEqual([...due].sort((a, b) => (a ?? Infinity) - (b ?? Infinity)))

    const undated = capitalPlanForProperty(property({ yearBuilt: null }), 2026)
    expect(undated.every((row) => row.dueYear == null)).toBe(true)
  })
})

describe('annualAccrualCents and dueWithinCents', () => {
  it('accrues each component over its own life', () => {
    const rows = capitalPlanForProperty(property({ yearBuilt: 2020 }), 2026)
    const expected = Object.values(CAPITAL_COMPONENTS).reduce(
      (total, spec) => total + Math.round(spec.defaultCostCents / spec.usefulLifeYears),
      0,
    )
    expect(annualAccrualCents(rows)).toBe(expected)
  })

  // Overdue is included on purpose: an eleven-years-late water heater has not
  // stopped being a bill, and dropping it reassures in the wrong direction.
  it('counts overdue components inside the window', () => {
    const rows = capitalPlanForProperty(property({ yearBuilt: 1996 }), 2026)
    const overdue = rows.filter((row) => row.dueYear != null && row.dueYear <= 2026)
    expect(overdue.length).toBeGreaterThan(0)
    expect(dueWithinCents(rows, 0, 2026)).toBe(
      overdue.reduce((total, row) => total + row.estimatedCostCents, 0),
    )
  })

  it('ignores undated components in the window', () => {
    expect(dueWithinCents(capitalPlanForProperty(property({ yearBuilt: null }), 2026), 50, 2026)).toBe(0)
  })
})

describe('reserveStatus', () => {
  it('reports the gap to target', () => {
    const status = reserveStatus({
      targetCents: 1_200_000,
      balanceCents: 845_000,
      balanceAsOf: '2026-08-01',
      today: '2026-08-22',
    })
    expect(status.shortfallCents).toBe(355_000)
    expect(status.balanceStale).toBe(false)
  })

  it('reports over-target as a negative shortfall, not zero', () => {
    const status = reserveStatus({
      targetCents: 900_000,
      balanceCents: 960_000,
      balanceAsOf: '2026-08-01',
      today: '2026-08-22',
    })
    expect(status.shortfallCents).toBe(-60_000)
  })

  it('leaves the gap null when nobody has counted, rather than calling it zero', () => {
    const status = reserveStatus({
      targetCents: 1_200_000,
      balanceCents: null,
      balanceAsOf: null,
      today: '2026-08-22',
    })
    expect(status.shortfallCents).toBeNull()
    expect(status.balanceStale).toBe(false)
  })

  it('flags a balance older than a year', () => {
    expect(
      reserveStatus({
        targetCents: 1,
        balanceCents: 1,
        balanceAsOf: '2025-08-21',
        today: '2026-08-22',
      }).balanceStale,
    ).toBe(true)
    // Exactly a year old is not yet stale - the boundary, stated.
    expect(
      reserveStatus({
        targetCents: 1,
        balanceCents: 1,
        balanceAsOf: '2025-08-22',
        today: '2026-08-22',
      }).balanceStale,
    ).toBe(false)
  })
})

describe('validatePropertyReserve', () => {
  it('accepts a target with no balance yet', () => {
    expect(validatePropertyReserve({ targetCents: 1_200_000, balanceCents: null })).toEqual([])
  })

  it('refuses a balance with no as-of date', () => {
    const violations = validatePropertyReserve({ targetCents: 1_200_000, balanceCents: 845_000 })
    expect(violations.map((v) => v.field)).toEqual(['balanceAsOf'])
  })

  it('refuses negative money', () => {
    const violations = validatePropertyReserve({ targetCents: -1, balanceCents: -1, balanceAsOf: '2026-08-01' })
    expect(violations.map((v) => v.field)).toEqual(['targetDollars', 'balanceDollars'])
  })
})
