import {
  type CapitalPlanRow,
  type ReserveStatus,
  annualAccrualCents,
  capitalPlanForProperty,
  dueWithinCents,
  reserveStatus,
} from '@rental/core/property'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for the reserve and capital-plan report (PAY-11, R-082). Fetch here,
// decide in `packages/core/property/capital-plan.ts` - the same split the tax
// export uses.

/// How far ahead the "coming due" figure looks. Five years is the horizon an
/// owner-operator actually budgets over; the full plan below shows every
/// component's own year regardless, so this is a summary figure, not a filter.
export const RESERVE_HORIZON_YEARS = 5

export interface PropertyReserveReport {
  propertyId: string
  propertyName: string
  legalEntityId: string
  legalEntityName: string
  /// Null until somebody sets one. A property with no target is listed, not
  /// hidden - an unconfigured reserve is the finding, not an absence.
  reserve: ReserveStatus | null
  plan: CapitalPlanRow[]
  /// What the plan says should be set aside each year across every component.
  annualAccrualCents: number
  dueWithinCents: number
}

export async function reserveReport(
  scope: ResolvedScope,
  now: Date,
): Promise<PropertyReserveReport[]> {
  const propertyIds = scope.availableProperties.map((property) => property.id)
  if (propertyIds.length === 0) return []

  const properties = await prisma.property.findMany({
    where: { id: { in: propertyIds } },
    select: {
      id: true,
      name: true,
      yearBuilt: true,
      timezone: true,
      legalEntity: { select: { id: true, name: true } },
      units: { select: { id: true, name: true } },
      capitalImprovements: { select: { category: true, inServiceOn: true, costCents: true } },
      reserve: { select: { targetCents: true, balanceCents: true, balanceAsOf: true } },
    },
    orderBy: { name: 'asc' },
  })

  const appliances = await prisma.appliance.findMany({
    where: { unit: { propertyId: { in: propertyIds } } },
    select: { unitId: true, category: true, installedOn: true },
  })
  const appliancesByProperty = new Map<string, typeof appliances>()
  const propertyOfUnit = new Map<string, string>()
  for (const property of properties) {
    for (const unit of property.units) propertyOfUnit.set(unit.id, property.id)
  }
  for (const appliance of appliances) {
    const propertyId = propertyOfUnit.get(appliance.unitId)
    if (!propertyId) continue
    const list = appliancesByProperty.get(propertyId) ?? []
    list.push(appliance)
    appliancesByProperty.set(propertyId, list)
  }

  return properties.map((property) => {
    // The plan works in calendar YEARS, and which year it is depends on the
    // property's own clock - on Vercel the server's is UTC, so a December
    // evening in Texas is already next year there. A component's age would be
    // off by one for a few hours every year end.
    const today = businessDate(now, property.timezone)
    const asOfYear = Number(today.slice(0, 4))

    const plan = capitalPlanForProperty(
      {
        propertyId: property.id,
        propertyName: property.name,
        yearBuilt: property.yearBuilt,
        units: property.units.map((unit) => ({ id: unit.id, label: unit.name })),
        // `@db.Date` columns, read the one way a calendar day may be read.
        improvements: property.capitalImprovements.map((row) => ({
          category: row.category,
          inServiceOn: row.inServiceOn ? utcToBusinessDate(row.inServiceOn) : null,
          costCents: row.costCents,
        })),
        appliances: (appliancesByProperty.get(property.id) ?? []).map((row) => ({
          unitId: row.unitId,
          category: row.category,
          installedOn: row.installedOn ? utcToBusinessDate(row.installedOn) : null,
        })),
      },
      asOfYear,
    )

    return {
      propertyId: property.id,
      propertyName: property.name,
      legalEntityId: property.legalEntity.id,
      legalEntityName: property.legalEntity.name,
      reserve: property.reserve
        ? reserveStatus({
            targetCents: property.reserve.targetCents,
            balanceCents: property.reserve.balanceCents,
            balanceAsOf: property.reserve.balanceAsOf
              ? utcToBusinessDate(property.reserve.balanceAsOf)
              : null,
            today,
          })
        : null,
      plan,
      annualAccrualCents: annualAccrualCents(plan),
      dueWithinCents: dueWithinCents(plan, RESERVE_HORIZON_YEARS, asOfYear),
    }
  })
}
