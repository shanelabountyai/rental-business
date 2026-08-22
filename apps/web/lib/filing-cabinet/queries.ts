import 'server-only'

import type {
  CapitalImprovement,
  HoaInfo,
  InsurancePolicy,
  Mortgage,
  MortgageAnnualStatement,
  Warranty,
} from '@rental/db'
import { prisma } from '@rental/db'
import {
  insuranceRenewalDue,
  mortgageArmAdjustmentDue,
  mortgageBalloonMaturityDue,
} from '@rental/core/filing-cabinet'
import { getPropertyDetail } from '@/lib/properties/queries.ts'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for the property filing cabinet (PROP-06, R-015). Scoped through
// getPropertyDetail, same convention as lib/operational/queries.ts uses
// through getUnitDetail: one scope check, every read here starts from it.

export interface FilingCabinet {
  costBasisCents: number | null
  mortgages: (Mortgage & { statements: MortgageAnnualStatement[] })[]
  insurancePolicies: InsurancePolicy[]
  hoaInfo: HoaInfo | null
  warranties: Warranty[]
  capitalImprovements: CapitalImprovement[]
}

export async function getFilingCabinet(
  propertyId: string,
  scope: ResolvedScope,
): Promise<FilingCabinet | null> {
  const property = await getPropertyDetail(propertyId, scope)
  if (!property) return null

  const [mortgages, insurancePolicies, hoaInfo, warranties, capitalImprovements] = await Promise.all([
    prisma.mortgage.findMany({
      where: { propertyId },
      orderBy: { createdAt: 'asc' },
      include: { statements: { orderBy: { taxYear: 'desc' } } },
    }),
    prisma.insurancePolicy.findMany({ where: { propertyId }, orderBy: { renewsOn: 'asc' } }),
    prisma.hoaInfo.findUnique({ where: { propertyId } }),
    prisma.warranty.findMany({ where: { propertyId }, orderBy: { category: 'asc' } }),
    // Newest first: the improvement somebody is about to look up is almost
    // always the one just done.
    prisma.capitalImprovement.findMany({
      where: { propertyId },
      orderBy: [{ inServiceOn: 'desc' }, { createdAt: 'desc' }],
    }),
  ])

  return {
    costBasisCents: property.costBasisCents,
    mortgages,
    insurancePolicies,
    hoaInfo,
    warranties,
    capitalImprovements,
  }
}

/// Every filing-cabinet alert due within its window, across every property in
/// scope - the "report, not automated action" surface PROP-05's future
/// compliance calendar (R-077) and the notification engine (R-016) will read
/// from once they exist. No caller wires this to a notification yet.
export interface FilingCabinetAlert {
  propertyId: string
  kind: 'ARM_ADJUSTMENT' | 'BALLOON_MATURITY' | 'INSURANCE_RENEWAL'
  dueOn: Date
  mortgage?: Mortgage
  insurancePolicy?: InsurancePolicy
}

export async function filingCabinetAlertsDue(
  scope: ResolvedScope,
  asOf: Date,
): Promise<FilingCabinetAlert[]> {
  if (scope.propertyIds.length === 0) return []

  const [mortgages, insurancePolicies] = await Promise.all([
    prisma.mortgage.findMany({ where: { propertyId: { in: scope.propertyIds } } }),
    prisma.insurancePolicy.findMany({ where: { propertyId: { in: scope.propertyIds } } }),
  ])

  const alerts: FilingCabinetAlert[] = []
  for (const mortgage of mortgages) {
    if (mortgageArmAdjustmentDue(mortgage, asOf) && mortgage.armAdjustmentDate) {
      alerts.push({
        propertyId: mortgage.propertyId,
        kind: 'ARM_ADJUSTMENT',
        dueOn: mortgage.armAdjustmentDate,
        mortgage,
      })
    }
    if (mortgageBalloonMaturityDue(mortgage, asOf) && mortgage.maturityDate) {
      alerts.push({
        propertyId: mortgage.propertyId,
        kind: 'BALLOON_MATURITY',
        dueOn: mortgage.maturityDate,
        mortgage,
      })
    }
  }
  for (const policy of insurancePolicies) {
    if (insuranceRenewalDue(policy.renewsOn, asOf)) {
      alerts.push({
        propertyId: policy.propertyId,
        kind: 'INSURANCE_RENEWAL',
        dueOn: policy.renewsOn,
        insurancePolicy: policy,
      })
    }
  }
  return alerts.sort((a, b) => a.dueOn.getTime() - b.dueOn.getTime())
}
