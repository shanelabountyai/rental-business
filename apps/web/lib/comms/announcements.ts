import 'server-only'

import {
  OPEN_TICKET_STATUSES,
  SENDABLE_STATUSES,
  type Segment,
  type TenancyFacts,
  WINDOW_DAYS,
  matchesSegment,
  parseSegment,
} from '@rental/core/comms'
import { balanceCents } from '@rental/core/ledger'
import { type PropertyScope } from '@rental/core/rbac'
import { businessDate, utcToBusinessDate } from '@rental/core/scheduling'
import { OPEN_WORK_ORDER_STATUSES } from '@rental/core/workorders'
import { prisma } from '@rental/db'
import { propertyWhere } from '@/lib/auth/guard.ts'

// Segment resolution for staff-authored announcements (COMM-04, R-053).
//
// Deliberately different from R-044's bulk chase (apps/web/lib/payments/
// reminders.ts), which sends to an EXPLICIT list of lease ids reviewed on
// screen because re-evaluating "who's chaseable" at send time could chase
// someone who paid in the meantime. An announcement has no such fact to go
// stale — "the city is flushing hydrants Tuesday" is true for whoever is a
// tenant at send time, and the whole point of a segment is that nobody
// enumerates it by hand. Resolving it as a filter, at send time, against the
// same `propertyWhere()` every other scoped list in this app already uses,
// is correct here rather than the shortcut that rule exists to forbid.
//
// ONE PREDICATE FOR THE COUNT AND THE SEND (R-258). Balance due, a move-out
// window and an open repair are not columns a Prisma `where` can say, so
// every in-scope tenancy's facts are loaded once (`loadFacts`) and
// `matchesSegment` decides both the number in the picker and who is sent to.
// Two code paths would be two answers to "how many", and R-115 exists because
// the picker's number is what a sender trusts before pressing send.
// ponytail: loads every in-scope tenancy and its ledger rows per render and
// per send. Fine at 10–50 doors; past a few thousand, push the property-level
// filters into the query and keep only the derived ones in JS.

/**
 * One choosable segment, and how many tenancies it reaches (R-115).
 *
 * THE COUNT IS THE POINT. The composer texts and emails everybody matching a
 * segment, had no confirmation step, and never said how many that was - the
 * per-recipient results table only renders after the send. The default is
 * "All tenants", so the highest blast radius was the option a mis-click landed
 * on, and nothing on the screen distinguished it from the smallest.
 *
 * The number goes in the OPTION rather than in the submit button, which is
 * where the audit put it: in the option it is visible before the choice is
 * made rather than after, and it needs no client state to stay accurate.
 *
 * It is an upper bound, deliberately. A lease under a `suppress_marketing`
 * hold, or a tenant whose merge fields cannot be filled, is dropped at send
 * time and named in the results - counting those here would mean running the
 * whole recipient resolution twice.
 */
export interface SegmentChoice {
  /// `ALL`, or `TYPE:value` — what the form posts, parsed by `parseSegment`.
  value: string
  label: string
  count: number
}

export interface SegmentOptions {
  all: SegmentChoice
  /// In picker order. A group with no choices is dropped by the form.
  groups: { label: string; choices: SegmentChoice[] }[]
}

interface LoadedFacts {
  facts: TenancyFacts[]
  properties: { id: string; name: string; legalEntityId: string; legalEntityName: string; metro: string | null; tags: string[] }[]
  units: Map<string, string>
}

/// Every sendable tenancy in scope, with what each segment reads. `null` when
/// the scope covers nothing.
async function loadFacts(scope: PropertyScope, now: Date): Promise<LoadedFacts | null> {
  const where = propertyWhere(scope)
  if (where === null) return null

  const propertyRows = await prisma.property.findMany({
    where: { ...where, active: true },
    select: {
      id: true,
      name: true,
      metro: true,
      tags: true,
      timezone: true,
      legalEntityId: true,
      legalEntity: { select: { name: true } },
    },
    orderBy: { name: 'asc' },
  })
  if (propertyRows.length === 0) return null
  const byId = new Map(propertyRows.map((p) => [p.id, p]))

  const leases = await prisma.lease.findMany({
    where: {
      status: { in: [...SENDABLE_STATUSES] },
      propertyId: { in: propertyRows.map((p) => p.id) },
    },
    select: {
      id: true,
      propertyId: true,
      unitId: true,
      status: true,
      startsOn: true,
      endsOn: true,
      noticeEffectiveOn: true,
      unit: { select: { name: true } },
    },
  })
  const leaseIds = leases.map((l) => l.id)
  const unitIds = [...new Set(leases.map((l) => l.unitId))]

  const [ledgerRows, tickets, workOrders] = await Promise.all([
    // The rows, not a SQL SUM - `balanceCents` is the one definition of a
    // balance (lib/ledger/queries.ts says why).
    prisma.ledgerEntry.findMany({
      where: { leaseId: { in: leaseIds } },
      select: { id: true, leaseId: true, amountCents: true },
    }),
    prisma.ticket.findMany({
      where: { unitId: { in: unitIds }, status: { in: [...OPEN_TICKET_STATUSES] } },
      select: { unitId: true },
      distinct: ['unitId'],
    }),
    prisma.workOrder.findMany({
      where: { unitId: { in: unitIds }, status: { in: [...OPEN_WORK_ORDER_STATUSES] } },
      select: { unitId: true },
      distinct: ['unitId'],
    }),
  ])

  const rowsByLease = new Map<string, { id: string; amountCents: number }[]>()
  for (const row of ledgerRows) {
    if (!row.leaseId) continue
    const list = rowsByLease.get(row.leaseId) ?? []
    list.push(row)
    rowsByLease.set(row.leaseId, list)
  }
  const unitsWithRepairs = new Set([...tickets, ...workOrders].map((r) => r.unitId))

  const facts = leases.map((lease): TenancyFacts => {
    const property = byId.get(lease.propertyId)!
    const end = lease.noticeEffectiveOn ?? lease.endsOn
    return {
      leaseId: lease.id,
      legalEntityId: property.legalEntityId,
      propertyId: lease.propertyId,
      unitId: lease.unitId,
      metro: property.metro,
      tags: property.tags,
      status: lease.status,
      today: businessDate(now, property.timezone),
      startsOn: utcToBusinessDate(lease.startsOn),
      endsOn: end ? utcToBusinessDate(end) : null,
      balanceCents: balanceCents(
        (rowsByLease.get(lease.id) ?? []).map((row) => ({
          ...row,
          type: '',
          occurredAt: new Date(0),
          description: '',
        })),
      ),
      openMaintenance: unitsWithRepairs.has(lease.unitId),
    }
  })

  return {
    facts,
    properties: propertyRows.map((p) => ({
      id: p.id,
      name: p.name,
      legalEntityId: p.legalEntityId,
      legalEntityName: p.legalEntity.name,
      metro: p.metro,
      tags: p.tags,
    })),
    units: new Map(leases.map((l) => [l.unitId, `${byId.get(l.propertyId)!.name} · ${l.unit.name}`])),
  }
}

/// The lease ids a segment reaches, inside the actor's scope.
export async function resolveSegment(
  scope: PropertyScope,
  segment: Segment,
  now = new Date(),
): Promise<string[]> {
  const loaded = await loadFacts(scope, now)
  if (!loaded) return []
  return loaded.facts.filter((f) => matchesSegment(f, segment)).map((f) => f.leaseId)
}

/** What the composer's segment picker offers, narrowed to the actor's scope. */
export async function segmentOptions(
  scope: PropertyScope,
  now = new Date(),
): Promise<SegmentOptions> {
  const loaded = await loadFacts(scope, now)
  if (!loaded) return { all: { value: 'ALL', label: 'All tenants', count: 0 }, groups: [] }
  const { facts, properties, units } = loaded

  const choice = (value: string, label: string): SegmentChoice => {
    const segment = parseSegment(value)!
    return { value, label, count: facts.filter((f) => matchesSegment(f, segment)).length }
  }
  const entities = new Map(properties.map((p) => [p.legalEntityId, p.legalEntityName]))
  const metros = [...new Set(properties.map((p) => p.metro).filter((m): m is string => !!m))].sort()
  const tags = [...new Set(properties.flatMap((p) => p.tags))].sort()

  return {
    all: choice('ALL', 'All tenants'),
    groups: [
      {
        label: 'Who owes or needs something',
        choices: [
          choice('BALANCE_DUE', 'Balance due'),
          choice('OPEN_MAINTENANCE', 'Open maintenance request'),
        ],
      },
      {
        label: 'Moving in (either side of today)',
        choices: WINDOW_DAYS.map((d) => choice(`MOVE_IN:${d}`, `Move-in within ${d} days`)),
      },
      {
        label: 'Moving out (next)',
        choices: WINDOW_DAYS.map((d) => choice(`MOVE_OUT:${d}`, `Move-out within ${d} days`)),
      },
      {
        label: 'Lease status',
        choices: [choice('STATUS:ACTIVE', 'Fixed term'), choice('STATUS:MONTH_TO_MONTH', 'Month-to-month')],
      },
      {
        label: 'One legal entity',
        choices: [...entities]
          .sort((a, b) => a[1].localeCompare(b[1]))
          .map(([id, name]) => choice(`ENTITY:${id}`, name)),
      },
      { label: 'One property', choices: properties.map((p) => choice(`PROPERTY:${p.id}`, p.name)) },
      {
        label: 'One unit',
        choices: [...units]
          .sort((a, b) => a[1].localeCompare(b[1]))
          .map(([id, name]) => choice(`UNIT:${id}`, name)),
      },
      { label: 'One metro', choices: metros.map((m) => choice(`METRO:${m}`, m)) },
      { label: 'One tag', choices: tags.map((t) => choice(`TAG:${t}`, t)) },
    ],
  }
}
