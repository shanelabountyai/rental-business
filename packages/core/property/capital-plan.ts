// The crude capital plan and the reserve it funds (PAY-11, R-082).
//
// ===========================================================================
// "CRUDE" IS THE SPEC, NOT AN APOLOGY. This projects when a roof, a furnace
// and a water heater are likely to come due, from the ages this product
// already knows, so an owner can see whether the reserve target they set is
// anywhere near the bill that is coming. It is not a depreciation schedule
// (R-078's CapEx section is what a preparer uses), it is not a condition
// assessment, and it does not claim to know the state of a roof it has never
// seen. Its whole value is that a number derived from an install date beats
// the number an owner would otherwise pull out of the air.
// ===========================================================================
//
// NOTHING NEW IS STORED TO PRODUCE IT. Every date it reads is already
// recorded for another reason:
//
//   - `CapitalImprovement.inServiceOn` (R-078) - a replacement, which RESETS
//     the clock. Recording the new roof is what moves the roof line out
//     twenty-five years, so the plan stays current as a side effect of the
//     bookkeeping somebody already does.
//   - `Appliance.installedOn` (R-014) - per unit, which is why the water
//     heater and the furnace are projected per unit and the roof is not.
//   - `Property.yearBuilt` - the last resort, and reported as an ASSUMPTION
//     rather than a fact. "Assumed original" is a very different claim from a
//     recorded install date, and a plan that blurs the two is one an owner
//     stops trusting the first time it is wrong.
//
// A component with no date from any of those three is reported as unknown,
// with no due year and no dollars. Guessing an age would put a number on a
// reserve target, and a made-up number in a money figure is worse than a gap
// that says "we don't know".

import type { BusinessDate } from '../scheduling/local-time.ts'

export type ComponentScope = 'property' | 'unit'

export interface CapitalComponent {
  label: string
  usefulLifeYears: number
  /// What a replacement costs when this property has never recorded one.
  ///
  // ponytail: one national-ish default per component, no per-property
  // override UI. The upgrade path is already free and better than a settings
  // screen would be - recording the actual `CapitalImprovement` when the work
  // is done replaces this estimate with what this owner really paid on this
  // house (see `estimatedCostCents` below). Add an override field only if
  // somebody needs a forecast BEFORE their first replacement.
  defaultCostCents: number
  /// A roof belongs to the building; a furnace belongs to a dwelling. On a
  /// duplex that is the difference between one roof line and two furnace
  /// lines, and getting it wrong halves or doubles the reserve.
  scope: ComponentScope
  /// The `Appliance.category` values that date this component, if any.
  applianceCategories: readonly string[]
}

/// Keyed by `CapitalImprovement.category` so a recorded replacement lines up
/// with the component it replaced without a translation table.
export const CAPITAL_COMPONENTS: Record<string, CapitalComponent> = {
  ROOF: {
    label: 'Roof',
    usefulLifeYears: 25,
    defaultCostCents: 1_200_000,
    scope: 'property',
    applianceCategories: [],
  },
  HVAC: {
    label: 'HVAC',
    usefulLifeYears: 18,
    defaultCostCents: 750_000,
    scope: 'unit',
    applianceCategories: ['HVAC'],
  },
  WATER_HEATER: {
    label: 'Water heater',
    usefulLifeYears: 12,
    defaultCostCents: 180_000,
    scope: 'unit',
    applianceCategories: ['WATER_HEATER'],
  },
  FLOORING: {
    label: 'Flooring',
    usefulLifeYears: 12,
    defaultCostCents: 600_000,
    scope: 'unit',
    applianceCategories: [],
  },
  EXTERIOR: {
    label: 'Exterior paint and siding',
    usefulLifeYears: 10,
    defaultCostCents: 500_000,
    scope: 'property',
    applianceCategories: [],
  },
}

export type CapitalComponentKey = keyof typeof CAPITAL_COMPONENTS

export type AgeSource = 'improvement' | 'appliance' | 'assumed_original' | 'unknown'

export interface CapitalPlanRow {
  propertyId: string
  /// Null on a property-scoped component.
  unitId: string | null
  unitLabel: string | null
  component: string
  label: string
  usefulLifeYears: number
  ageSource: AgeSource
  /// The calendar year the clock starts from. Null when nothing dates it.
  installedYear: number | null
  ageYears: number | null
  /// `installedYear + usefulLifeYears`. Null when nothing dates it.
  dueYear: number | null
  /// Negative once it is overdue - which is the useful direction, because an
  /// overdue component is the one the reserve is actually for.
  yearsRemaining: number | null
  estimatedCostCents: number
  costSource: 'recorded' | 'default'
  /// This component's share of what should be set aside each year. Zero when
  /// the component is undated: accruing against a date nobody knows would put
  /// invented precision into the one number an owner acts on.
  annualAccrualCents: number
}

export interface PlanUnitFacts {
  id: string
  label: string
}

export interface PlanImprovementFacts {
  category: string
  /// `CapitalImprovement.inServiceOn`, already read as a calendar day.
  inServiceOn: BusinessDate | null
  costCents: number
}

export interface PlanApplianceFacts {
  unitId: string
  category: string
  /// `Appliance.installedOn`, already read as a calendar day.
  installedOn: BusinessDate | null
}

export interface PlanPropertyFacts {
  propertyId: string
  propertyName: string
  yearBuilt: number | null
  units: readonly PlanUnitFacts[]
  improvements: readonly PlanImprovementFacts[]
  appliances: readonly PlanApplianceFacts[]
}

/// `BusinessDate` is `YYYY-MM-DD`, so the year is the first four characters
/// and no timezone is involved. Both dates this reads are `@db.Date` columns
/// - calendar days, which no zone may touch (CLAUDE.md).
function yearOf(day: BusinessDate): number {
  return Number(day.slice(0, 4))
}

/// The most recent recorded replacement of one component, or null. Most
/// recent and not first: a roof replaced in 2004 and again in 2021 is a 2021
/// roof, and taking the earliest would have the plan permanently recommending
/// work that was already done.
function latestImprovement(
  improvements: readonly PlanImprovementFacts[],
  category: string,
): PlanImprovementFacts | null {
  let best: PlanImprovementFacts | null = null
  for (const improvement of improvements) {
    if (improvement.category !== category) continue
    if (improvement.inServiceOn == null) continue
    if (best?.inServiceOn == null || improvement.inServiceOn > best.inServiceOn) best = improvement
  }
  return best
}

export function capitalPlanForProperty(
  facts: PlanPropertyFacts,
  asOfYear: number,
): CapitalPlanRow[] {
  const rows: CapitalPlanRow[] = []

  for (const [component, spec] of Object.entries(CAPITAL_COMPONENTS)) {
    const improvement = latestImprovement(facts.improvements, component)

    // A recorded replacement on THIS property beats any default: it is what
    // this owner actually paid, for this house, in this market.
    const estimatedCostCents = improvement?.costCents ?? spec.defaultCostCents
    const costSource: CapitalPlanRow['costSource'] = improvement ? 'recorded' : 'default'

    const targets: Array<{ unitId: string | null; unitLabel: string | null }> =
      spec.scope === 'property'
        ? [{ unitId: null, unitLabel: null }]
        : facts.units.map((unit) => ({ unitId: unit.id, unitLabel: unit.label }))

    for (const target of targets) {
      // Order matters and is the whole honesty story of this function: a
      // dated appliance on THIS unit is the best evidence, then a recorded
      // replacement on the property, then the building's own age as an
      // explicit assumption.
      const appliance =
        target.unitId == null
          ? null
          : facts.appliances.find(
              (row) =>
                row.unitId === target.unitId &&
                row.installedOn != null &&
                spec.applianceCategories.includes(row.category),
            ) ?? null

      let ageSource: AgeSource = 'unknown'
      let installedYear: number | null = null

      if (appliance?.installedOn) {
        ageSource = 'appliance'
        installedYear = yearOf(appliance.installedOn)
      } else if (improvement?.inServiceOn) {
        ageSource = 'improvement'
        installedYear = yearOf(improvement.inServiceOn)
      } else if (facts.yearBuilt != null) {
        ageSource = 'assumed_original'
        installedYear = facts.yearBuilt
      }

      const dueYear = installedYear == null ? null : installedYear + spec.usefulLifeYears
      rows.push({
        propertyId: facts.propertyId,
        unitId: target.unitId,
        unitLabel: target.unitLabel,
        component,
        label: spec.label,
        usefulLifeYears: spec.usefulLifeYears,
        ageSource,
        installedYear,
        ageYears: installedYear == null ? null : asOfYear - installedYear,
        dueYear,
        yearsRemaining: dueYear == null ? null : dueYear - asOfYear,
        estimatedCostCents,
        costSource,
        annualAccrualCents:
          installedYear == null ? 0 : Math.round(estimatedCostCents / spec.usefulLifeYears),
      })
    }
  }

  // Soonest first, undated last - the order somebody reading it to decide
  // what to budget for actually wants.
  return rows.sort((a, b) => {
    if (a.dueYear == null) return b.dueYear == null ? 0 : 1
    if (b.dueYear == null) return -1
    return a.dueYear - b.dueYear || a.label.localeCompare(b.label)
  })
}

export function annualAccrualCents(rows: readonly CapitalPlanRow[]): number {
  return rows.reduce((total, row) => total + row.annualAccrualCents, 0)
}

/**
 * What the plan says is coming due in the next `years` years, INCLUDING
 * anything already overdue.
 *
 * Overdue is included deliberately: a water heater eleven years past its life
 * has not stopped being a bill, and a forecast that quietly drops it is
 * reassuring in exactly the wrong direction.
 */
export function dueWithinCents(rows: readonly CapitalPlanRow[], years: number, asOfYear: number): number {
  return rows.reduce((total, row) => {
    if (row.dueYear == null) return total
    return row.dueYear <= asOfYear + years ? total + row.estimatedCostCents : total
  }, 0)
}

export interface ReserveStatus {
  targetCents: number
  /// Null means nobody has recorded a balance - shown as "not recorded",
  /// never as zero (D-76).
  balanceCents: number | null
  balanceAsOf: BusinessDate | null
  /// Positive when short of target, negative when over. Null when there is no
  /// balance to compare against.
  shortfallCents: number | null
  /// True when the recorded balance is older than a year. A reserve figure
  /// read as current when it is eighteen months stale is the failure mode
  /// `balanceAsOf` exists to make visible.
  balanceStale: boolean
}

export function reserveStatus(facts: {
  targetCents: number
  balanceCents: number | null
  balanceAsOf: BusinessDate | null
  today: BusinessDate
}): ReserveStatus {
  const staleBefore = `${yearOf(facts.today) - 1}${facts.today.slice(4)}`
  return {
    targetCents: facts.targetCents,
    balanceCents: facts.balanceCents,
    balanceAsOf: facts.balanceAsOf,
    shortfallCents: facts.balanceCents == null ? null : facts.targetCents - facts.balanceCents,
    balanceStale: facts.balanceAsOf != null && facts.balanceAsOf < staleBefore,
  }
}
