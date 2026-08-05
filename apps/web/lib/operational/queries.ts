import 'server-only'

import type { AccessCode, Appliance, ShutoffLocation, UtilityAccount } from '@rental/db'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'
import { getUnitDetail } from '@/lib/units/queries.ts'

// Reads for unit operational data (PROP-03, R-014). Scoped through the unit's
// own property, same as every other unit-attached read in this codebase -
// getUnitDetail() already does the (property in scope) AND (unit belongs to
// that property) check R-009 built, so every function here starts from it
// rather than re-deriving the same two conditions.

export interface OperationalData {
  accessCodes: AccessCode[]
  appliances: Appliance[]
  utilityAccounts: UtilityAccount[]
  shutoffs: ShutoffLocation[]
}

/// Current (non-superseded) access codes plus everything else - "current"
/// for the other three tables just means "every row", since only AccessCode
/// is versioned.
export async function getOperationalData(
  propertyId: string,
  unitId: string,
  scope: ResolvedScope,
): Promise<OperationalData | null> {
  const unit = await getUnitDetail(propertyId, unitId, scope)
  if (!unit) return null

  const [accessCodes, appliances, utilityAccounts, shutoffs] = await Promise.all([
    prisma.accessCode.findMany({ where: { unitId, effectiveTo: null }, orderBy: { type: 'asc' } }),
    prisma.appliance.findMany({ where: { unitId }, orderBy: { category: 'asc' } }),
    prisma.utilityAccount.findMany({ where: { unitId }, orderBy: { type: 'asc' } }),
    prisma.shutoffLocation.findMany({ where: { unitId }, orderBy: { type: 'asc' } }),
  ])

  return { accessCodes, appliances, utilityAccounts, shutoffs }
}

/// Every version ever recorded for one (unitId, type) access-code slot,
/// newest first - the "history log" PROP-03 asks for.
export async function getAccessCodeHistory(
  propertyId: string,
  unitId: string,
  type: string,
  scope: ResolvedScope,
): Promise<AccessCode[]> {
  const unit = await getUnitDetail(propertyId, unitId, scope)
  if (!unit) return []
  return prisma.accessCode.findMany({
    where: { unitId, type },
    orderBy: { version: 'desc' },
  })
}

export async function getAccessCode(
  propertyId: string,
  unitId: string,
  accessCodeId: string,
  scope: ResolvedScope,
): Promise<AccessCode | null> {
  const unit = await getUnitDetail(propertyId, unitId, scope)
  if (!unit) return null
  const code = await prisma.accessCode.findUnique({ where: { id: accessCodeId } })
  if (!code || code.unitId !== unitId) return null
  return code
}
