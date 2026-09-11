import 'server-only'

import {
  type EntitySettlement,
  type SettlementPayment,
  summariseSettlements,
} from '@rental/core/payments'
import { businessDate, businessDateToUtc, utcToBusinessDate } from '@rental/core/scheduling'
import type { BusinessDate } from '@rental/core/scheduling'
import { type Prisma, prisma } from '@rental/db'
import type { ResolvedScope } from '@/lib/scope/current-scope.ts'

// The per-entity settlement report (review finding 12, R-180). The arithmetic
// lives in packages/core/payments/settlement.ts; this is the fetch.
//
// ==========================================================================
// WHAT COUNTS AS A SETTLEMENT, AND WHY IT IS NOT THE CHANNEL.
//
// `Payment.channel` cannot answer this. The webhook says so in its own words:
// "every invoice-driven payment lands here with `rail: null` and so
// `channel: OTHER`, and the channel therefore says nothing about where the
// money came from". So a `CARD`/`ACH` filter would silently drop most online
// rent, and an `OTHER` row is not evidence of anything either way.
//
// The discriminator is `receivedByStaffId`, which is the same one the webhook
// itself uses to recognise money we recorded ourselves. `recordOfflinePayment`
// in lib/payments/offline.ts is the ONLY writer of that column anywhere in the
// codebase (verified by grep, and asserted in two comments there), so a null
// means Stripe originated the row.
//
// AND OFFLINE MONEY GENUINELY DID NOT SETTLE HERE. A check reaches Stripe as
// an OUT-OF-BAND payment against the open invoice: it stops Stripe collecting
// and moves the ledger, but no money passes through the Stripe balance, so it
// will never appear in a payout or on this bank line. It is somebody walking
// to a bank with a deposit slip - which is R-166's screen, and the page links
// there rather than pretending the two are one number.
//
// STATUS. `SETTLED`, `REVERSED` and `REFUNDED` all describe money that
// reached the balance; the last two also left it again and carry their own
// date. `PENDING` has not landed and `FAILED` never did.
//
// `reversedAt ?? receivedAt` IS DELIBERATE AND IS NOT A GUESS. The webhook has
// one path that creates a row already in `REFUNDED` - a refund arriving for a
// PaymentIntent we never saw succeed - and that row has no `reversedAt`, while
// its `receivedAt` is the refund's own timestamp. Dating the clawback to
// `receivedAt` there makes it settle and reverse on the same day, netting to
// zero. The alternative is worse in a way that is silent: leaving
// `reversedOn` null counts a refund as pure income and overstates the entity's
// share of a bank account.
// ==========================================================================

export interface SettlementRow {
  paymentId: string
  legalEntityId: string
  entityName: string
  propertyId: string
  propertyName: string
  unitName: string | null
  payerName: string
  channel: string
  amountCents: number
  settledOn: BusinessDate
  reversedOn: BusinessDate | null
}

export interface SettlementPropertyRow {
  propertyId: string
  propertyName: string
  settledCents: number
  reversedCents: number
  netCents: number
}

export interface SettlementEntityRow extends Omit<EntitySettlement, 'properties'> {
  entityName: string
  properties: SettlementPropertyRow[]
}

export interface SettlementReport {
  from: BusinessDate
  to: BusinessDate
  entities: SettlementEntityRow[]
  settledCents: number
  reversedCents: number
  netCents: number
  /// Every payment behind the totals, newest settlement first. This is what
  /// makes the report reconcilable rather than four numbers to trust.
  rows: SettlementRow[]
}

function payerName(payer: {
  tenant: { firstName: string; lastName: string } | null
  externalPayerName: string | null
}): string {
  if (payer.tenant) return `${payer.tenant.firstName} ${payer.tenant.lastName}`
  return payer.externalPayerName ?? 'Unnamed payer'
}

/**
 * What settled into the shared Stripe balance in `[from, to]`, by entity.
 *
 * The SQL window carries a day of slack at each end and the real filtering
 * happens in core through each PROPERTY's own zone - the same shape
 * `taxExportFacts` uses, and for the same reason: an entity's properties can
 * span several timezones (D-3), so there is no single zone to filter in SQL.
 */
export async function settlementReport(
  scope: ResolvedScope,
  from: BusinessDate,
  to: BusinessDate,
): Promise<SettlementReport> {
  const empty: SettlementReport = {
    from,
    to,
    entities: [],
    settledCents: 0,
    reversedCents: 0,
    netCents: 0,
    rows: [],
  }
  if (scope.propertyIds.length === 0) return empty

  const windowStart = new Date(`${from}T00:00:00Z`)
  windowStart.setUTCDate(windowStart.getUTCDate() - 1)
  const windowEnd = new Date(`${to}T23:59:59.999Z`)
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 1)

  const payments = await prisma.payment.findMany({
    where: {
      propertyId: { in: scope.propertyIds },
      receivedByStaffId: null,
      status: { in: ['SETTLED', 'REVERSED', 'REFUNDED'] },
      OR: [
        { receivedAt: { gte: windowStart, lte: windowEnd } },
        { reversedAt: { gte: windowStart, lte: windowEnd } },
      ],
    },
    select: {
      id: true,
      amountCents: true,
      channel: true,
      status: true,
      receivedAt: true,
      reversedAt: true,
      propertyId: true,
      property: {
        select: {
          name: true,
          timezone: true,
          legalEntityId: true,
          legalEntity: { select: { name: true } },
        },
      },
      lease: { select: { unit: { select: { name: true } } } },
      leasePayer: {
        select: {
          tenant: { select: { firstName: true, lastName: true } },
          externalPayerName: true,
        },
      },
    },
    orderBy: { receivedAt: 'desc' },
  })
  if (payments.length === 0) return empty

  const dated = payments.map((row) => {
    const zone = row.property.timezone
    const reversed = row.status === 'SETTLED' ? null : (row.reversedAt ?? row.receivedAt)
    return {
      row,
      settledOn: businessDate(row.receivedAt, zone),
      reversedOn: reversed === null ? null : businessDate(reversed, zone),
    }
  })

  const coreInput: SettlementPayment[] = dated.map((entry) => ({
    id: entry.row.id,
    legalEntityId: entry.row.property.legalEntityId,
    propertyId: entry.row.propertyId,
    amountCents: entry.row.amountCents,
    settledOn: entry.settledOn,
    reversedOn: entry.reversedOn,
  }))

  const summary = summariseSettlements(coreInput, { from, to })

  const entityNames = new Map(
    payments.map((row) => [row.property.legalEntityId, row.property.legalEntity.name]),
  )
  const propertyNames = new Map(payments.map((row) => [row.propertyId, row.property.name]))

  // Only the payments a window actually counted. Listing every fetched row
  // would put the slack days and the out-of-window halves of a reversal on a
  // page whose totals do not include them.
  const counted = new Set(summary.entities.flatMap((entity) => entity.paymentIds))

  return {
    from,
    to,
    entities: summary.entities.map((entity) => ({
      ...entity,
      entityName: entityNames.get(entity.legalEntityId) ?? 'Unknown entity',
      properties: entity.properties.map((property) => ({
        ...property,
        propertyName: propertyNames.get(property.propertyId) ?? 'Unknown property',
      })),
    })),
    settledCents: summary.settledCents,
    reversedCents: summary.reversedCents,
    netCents: summary.netCents,
    rows: dated
      .filter((entry) => counted.has(entry.row.id))
      .map((entry) => ({
        paymentId: entry.row.id,
        legalEntityId: entry.row.property.legalEntityId,
        entityName: entry.row.property.legalEntity.name,
        propertyId: entry.row.propertyId,
        propertyName: entry.row.property.name,
        unitName: entry.row.lease.unit?.name ?? null,
        payerName: payerName(entry.row.leasePayer),
        channel: entry.row.channel,
        amountCents: entry.row.amountCents,
        settledOn: entry.settledOn,
        reversedOn: entry.reversedOn,
      })),
  }
}

export interface RecordedSettlement {
  id: string
  legalEntityId: string
  windowFrom: BusinessDate
  windowTo: BusinessDate
  grossCents: number
  transferredCents: number
  transferredOn: BusinessDate
  reference: string
  documentId: string
  recordedByName: string
}

/**
 * Transfers already recorded (R-198) whose range shares at least one day with
 * `[from, to]`.
 *
 * ONE PREDICATE FOR THE PAGE AND THE WRITE. The page uses it to show the record
 * in place of the form; the action uses it, inside the transaction, to refuse a
 * second transfer. A range that merely touches a recorded one - 1 April after a
 * March sweep - does not overlap; a range sharing its last day does, because
 * that day's rent would be moved twice.
 */
export async function recordedSettlements(
  legalEntityIds: readonly string[],
  from: BusinessDate,
  to: BusinessDate,
  db: Prisma.TransactionClient = prisma,
): Promise<RecordedSettlement[]> {
  if (legalEntityIds.length === 0) return []
  const rows = await db.entitySettlement.findMany({
    where: {
      legalEntityId: { in: [...legalEntityIds] },
      windowFrom: { lte: businessDateToUtc(to) },
      windowTo: { gte: businessDateToUtc(from) },
    },
    orderBy: { windowFrom: 'asc' },
    select: {
      id: true,
      legalEntityId: true,
      windowFrom: true,
      windowTo: true,
      grossCents: true,
      transferredCents: true,
      transferredOn: true,
      reference: true,
      documentId: true,
      recordedBy: { select: { name: true } },
    },
  })
  return rows.map((row) => ({
    id: row.id,
    legalEntityId: row.legalEntityId,
    // @db.Date columns: calendar days straight through, no zone (D-3).
    windowFrom: utcToBusinessDate(row.windowFrom),
    windowTo: utcToBusinessDate(row.windowTo),
    grossCents: row.grossCents,
    transferredCents: row.transferredCents,
    transferredOn: utcToBusinessDate(row.transferredOn),
    reference: row.reference,
    documentId: row.documentId,
    recordedByName: row.recordedBy.name,
  }))
}
