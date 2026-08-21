import 'server-only'

import { nextPreventiveDueDate } from '@rental/core/workorders'
import { businessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for preventive-maintenance batch templates (MAINT-08, R-080).

export async function listPreventiveTemplates() {
  return prisma.preventiveMaintenanceTemplate.findMany({ orderBy: { name: 'asc' } })
}

export async function getPreventiveTemplate(id: string) {
  return prisma.preventiveMaintenanceTemplate.findUnique({ where: { id } })
}

type UnitWithLastPerformed = {
  id: string
  name: string
  property: { id: string; name: string; timezone: string; city: string; postalCode: string }
  workOrders: { closedAt: Date | null }[]
}

/// Every unit in scope, with whichever CLOSED work order most recently
/// fulfilled this template - the same "read the last real event off the row
/// that recorded it" posture the periodic-inspection scheduling job already
/// takes for `Inspection.performedAt`, just against `WorkOrder.closedAt`
/// instead of a dedicated schedule-tracking table.
async function unitsWithLastPerformed(
  templateId: string,
  propertyIds: readonly string[],
): Promise<UnitWithLastPerformed[]> {
  if (propertyIds.length === 0) return []
  return prisma.unit.findMany({
    where: { propertyId: { in: [...propertyIds] } },
    select: {
      id: true,
      name: true,
      property: { select: { id: true, name: true, timezone: true, city: true, postalCode: true } },
      workOrders: {
        where: { pmTemplateId: templateId, status: 'CLOSED' },
        orderBy: { closedAt: 'desc' },
        take: 1,
        select: { closedAt: true },
      },
    },
  })
}

/// Never fulfilled before: due now, not a guess - the system has no real
/// evidence this task was ever done for this unit. Otherwise, due once
/// `nextPreventiveDueDate()` off the last CLOSED job has arrived, checked in
/// the property's own local time (the same convention every other due-date
/// check in this product takes).
function isDue(unit: UnitWithLastPerformed, intervalMonths: number): boolean {
  const lastClosed = unit.workOrders[0]?.closedAt
  if (!lastClosed) return true
  const today = businessDate(new Date(), unit.property.timezone)
  const lastPerformed = businessDate(lastClosed, unit.property.timezone)
  return nextPreventiveDueDate(lastPerformed, intervalMonths) <= today
}

/// How many units in scope are due right now - the count a PM sees on the
/// template list before deciding whether "run the batch" is worth clicking.
export async function dueCountForTemplate(
  templateId: string,
  template: { intervalMonths: number },
  scope: ResolvedScope,
): Promise<number> {
  const units = await unitsWithLastPerformed(templateId, scope.propertyIds)
  return units.filter((unit) => isDue(unit, template.intervalMonths)).length
}

export interface DueUnit {
  unitId: string
  unitName: string
  propertyId: string
  propertyName: string
  propertyTimezone: string
  propertyCity: string
  propertyPostalCode: string
}

/// The actual list a batch run acts on - same due computation as
/// `dueCountForTemplate`, just returning the rows instead of the count.
export async function dueUnitsForTemplate(
  templateId: string,
  template: { intervalMonths: number },
  scope: ResolvedScope,
): Promise<DueUnit[]> {
  const units = await unitsWithLastPerformed(templateId, scope.propertyIds)
  return units
    .filter((unit) => isDue(unit, template.intervalMonths))
    .map((unit) => ({
      unitId: unit.id,
      unitName: unit.name,
      propertyId: unit.property.id,
      propertyName: unit.property.name,
      propertyTimezone: unit.property.timezone,
      propertyCity: unit.property.city,
      propertyPostalCode: unit.property.postalCode,
    }))
}
