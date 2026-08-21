import 'server-only'

import {
  type AccountingBasis,
  type IncomeFact,
  type TaxExport,
  type TaxExportFacts,
  buildTaxExport,
} from '@rental/core/tax'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// Reads for the year-end tax export (RPT-03, R-078). Fetch here, decide in
// `packages/core/tax` - the same split lib/reports/queries.ts uses.
//
// ===========================================================================
// THE BASIS PICKS THE INCOME TABLE, and that is the only place in this file
// where it matters. Cash-basis income is money that MOVED, which lives in
// `LedgerEntry` as the Stripe projection (D-11). Accrual-basis income is the
// obligation, which lives in `Charge`. They are genuinely different tables,
// so the choice is made once, here, and everything downstream sees one
// uniform `IncomeFact` list.
// ===========================================================================

/**
 * Cash-basis income is exactly the ledger rows that CARRY A PAYMENT.
 *
 * Not a filter on `LedgerEntryType`, which would need three values and get
 * one of them wrong: `webhook.ts` sets `paymentId` on every row that
 * represents money arriving or being clawed back - the charge-linked rows,
 * the unlinked subscription remainder, and the reversals a return produces -
 * and on nothing else. A `CHARGE` row raised when an invoice is posted has
 * no payment and no business on a cash-basis return.
 */
const CASH_INCOME_WHERE = { paymentId: { not: null } } as const

export interface EntityChoice {
  id: string
  name: string
}

/// The entities the actor can actually export, from their own scope. A
/// property-scoped manager sees the entity that property belongs to and
/// nothing else.
export function exportableEntities(scope: ResolvedScope): EntityChoice[] {
  const byId = new Map<string, string>()
  const namesFromScope = new Map(scope.availableEntities.map((entity) => [entity.id, entity.name]))
  for (const property of scope.availableProperties) {
    if (!scope.propertyIds.includes(property.id)) continue
    const name = namesFromScope.get(property.legalEntityId)
    if (name) byId.set(property.legalEntityId, name)
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Every fact the export needs for one entity and one year.
 *
 * Timestamp columns are fetched over a window a day wider than the calendar
 * year at each end and filtered to the year in core, through the PROPERTY's
 * timezone. Filtering them in SQL would mean picking one zone for the whole
 * entity, and an entity's properties can span several (D-3).
 */
export async function taxExportFacts(
  scope: ResolvedScope,
  legalEntityId: string,
  year: number,
  basis: AccountingBasis,
): Promise<TaxExport | null> {
  const properties = scope.availableProperties.filter(
    (property) => property.legalEntityId === legalEntityId && scope.propertyIds.includes(property.id),
  )
  if (properties.length === 0) return null

  const propertyIds = properties.map((property) => property.id)
  const rows = await prisma.property.findMany({
    where: { id: { in: propertyIds } },
    select: { id: true, name: true, timezone: true },
  })
  const propertyNames = new Map(rows.map((row) => [row.id, row.name]))
  const propertyTimezones = new Map(rows.map((row) => [row.id, row.timezone]))
  const zoneOf = (propertyId: string) => propertyTimezones.get(propertyId) ?? 'UTC'

  const entity = await prisma.legalEntity.findUnique({
    where: { id: legalEntityId },
    select: { id: true, name: true },
  })
  if (!entity) return null

  // A day of slack at each end, so a property in any zone still sees its own
  // 1 January and 31 December.
  const windowStart = new Date(Date.UTC(year - 1, 11, 30))
  const windowEnd = new Date(Date.UTC(year + 1, 0, 2))
  // Calendar-day columns need no slack - a `@db.Date` is the same day
  // everywhere, and giving it slack would pull in a genuine neighbouring
  // year.
  const yearStart = new Date(Date.UTC(year, 0, 1))
  const yearEnd = new Date(Date.UTC(year, 11, 31))

  const [ledgerRows, chargeRows, workOrders, utilityBills, evictionCosts, capitalImprovements] =
    await Promise.all([
      basis === 'cash'
        ? prisma.ledgerEntry.findMany({
            where: {
              propertyId: { in: propertyIds },
              occurredAt: { gte: windowStart, lte: windowEnd },
              ...CASH_INCOME_WHERE,
            },
            select: {
              id: true,
              propertyId: true,
              occurredAt: true,
              amountCents: true,
              description: true,
              charge: { select: { type: true } },
            },
          })
        : Promise.resolve([]),
      basis === 'accrual'
        ? prisma.charge.findMany({
            where: {
              propertyId: { in: propertyIds },
              dueOn: { gte: yearStart, lte: yearEnd },
              // A waived charge was never income. R-035 records the waiver
              // rather than deleting the row, so it has to be excluded here.
              waivedAt: null,
            },
            select: {
              id: true,
              propertyId: true,
              dueOn: true,
              type: true,
              amountCents: true,
              description: true,
            },
          })
        : Promise.resolve([]),
      prisma.workOrder.findMany({
        where: {
          propertyId: { in: propertyIds },
          OR: [
            { invoicePaidAt: { gte: windowStart, lte: windowEnd } },
            { closedAt: { gte: windowStart, lte: windowEnd } },
          ],
        },
        select: {
          id: true,
          propertyId: true,
          scope: true,
          turnoverProjectId: true,
          actualLaborCents: true,
          actualMaterialsCents: true,
          invoiceCents: true,
          closedAt: true,
          invoicePaidAt: true,
          vendor: { select: { name: true } },
          capitalImprovement: { select: { id: true } },
        },
      }),
      prisma.utilityBill.findMany({
        where: {
          propertyId: { in: propertyIds },
          periodEnd: { gte: yearStart, lte: yearEnd },
          landlordCents: { not: null },
        },
        select: {
          id: true,
          propertyId: true,
          utilityType: true,
          landlordCents: true,
          periodEnd: true,
        },
      }),
      prisma.evictionCost.findMany({
        where: {
          incurredOn: { gte: yearStart, lte: yearEnd },
          evictionCase: { propertyId: { in: propertyIds } },
        },
        select: {
          id: true,
          type: true,
          description: true,
          amountCents: true,
          incurredOn: true,
          evictionCase: { select: { propertyId: true } },
        },
      }),
      prisma.capitalImprovement.findMany({
        where: {
          propertyId: { in: propertyIds },
          // An improvement with no in-service date has no year to belong to
          // and must still reach the export, where it becomes an exception
          // rather than disappearing.
          OR: [{ inServiceOn: { gte: yearStart, lte: yearEnd } }, { inServiceOn: null }],
        },
        select: {
          id: true,
          propertyId: true,
          category: true,
          description: true,
          costCents: true,
          inServiceOn: true,
        },
      }),
    ])

  const income: IncomeFact[] = [
    ...ledgerRows.map((row) => ({
      source: 'ledger' as const,
      sourceId: row.id,
      propertyId: row.propertyId,
      // A real timestamp, so it goes through the property's zone.
      bookedOn: businessDate(row.occurredAt, zoneOf(row.propertyId)),
      chargeType: row.charge?.type ?? null,
      amountCents: row.amountCents,
      description: row.description,
    })),
    ...chargeRows.map((row) => ({
      source: 'charge' as const,
      sourceId: row.id,
      propertyId: row.propertyId,
      // `dueOn` is `@db.Date` - a calendar day, which no zone may touch.
      bookedOn: utcToBusinessDate(row.dueOn),
      chargeType: row.type,
      amountCents: row.amountCents,
      description: row.description,
    })),
  ]

  const facts: TaxExportFacts = {
    legalEntityId: entity.id,
    legalEntityName: entity.name,
    year,
    propertyNames,
    propertyTimezones,
    income,
    workOrders: workOrders.map((row) => ({
      id: row.id,
      propertyId: row.propertyId,
      scope: row.scope,
      vendorName: row.vendor?.name ?? null,
      turnoverProjectId: row.turnoverProjectId,
      actualLaborCents: row.actualLaborCents,
      actualMaterialsCents: row.actualMaterialsCents,
      invoiceCents: row.invoiceCents,
      closedAt: row.closedAt,
      invoicePaidAt: row.invoicePaidAt,
      capitalised: row.capitalImprovement != null,
    })),
    utilityBills,
    evictionCosts: evictionCosts.map((row) => ({
      id: row.id,
      propertyId: row.evictionCase.propertyId,
      type: row.type,
      description: row.description,
      amountCents: row.amountCents,
      incurredOn: row.incurredOn,
    })),
    capitalImprovements,
  }

  return buildTaxExport(facts, basis)
}
