import 'server-only'

import { type Actor, type PropertyScope, can } from '@rental/core/rbac'
import { type BusinessDate, businessDateToUtc, utcToBusinessDate, wallClockToUtc } from '@rental/core/scheduling'
import { type Prisma, prisma } from '@rental/db'
import { propertyWhere } from '@/lib/auth/scope.ts'

// The org's own audit log (PRD 11 §4.15, R-295b): `/settings/audit` and its
// CSV. Rows on a property in the reader's scope, plus the org-level rows
// (no property) for a portfolio-wide reader, as every list here is scoped.
// `confidential.*` rows show only to `confidential.read` holders, as their
// own screens do; their content was redacted at write anyway.

export type OrgAuditFilters = { actor: string; grant: string; from: string; to: string }

export const ACTOR_TYPES = ['STAFF', 'TENANT', 'GUARANTOR', 'VENDOR', 'SYSTEM', 'PLATFORM'] as const

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function orgAuditFilters(params: Record<string, string | string[] | undefined>): OrgAuditFilters {
  const one = (key: string) => {
    const v = params[key]
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? ''
  }
  const actor = one('actor')
  return {
    actor: (ACTOR_TYPES as readonly string[]).includes(actor) ? actor : '',
    grant: one('grant'),
    from: DATE.test(one('from')) ? one('from') : '',
    to: DATE.test(one('to')) ? one('to') : '',
  }
}

/// Midnight starting a day in the org's zone.
function dayStart(day: string, zone: string): Date {
  return wallClockToUtc(`${day}T00:00`, zone)
}

/// The where clause, or null when the reader may see nothing.
export function orgAuditWhere(
  actor: Actor,
  scope: PropertyScope,
  f: OrgAuditFilters,
  zone: string,
): Prisma.AuditLogWhereInput | null {
  const inScope = propertyWhere(scope)
  if (!inScope) return null
  const and: Prisma.AuditLogWhereInput[] = [
    { OR: [{ property: inScope }, ...(scope.everything ? [{ propertyId: null, orgId: scope.orgId }] : [])] },
  ]
  if (!can(actor, 'confidential.read').allowed) and.push({ NOT: { action: { startsWith: 'confidential.' } } })
  if (f.actor) and.push({ actorType: f.actor as (typeof ACTOR_TYPES)[number] })
  // A grant's rows (D-380 item 3): the platform's carry `supportGrantId`; an
  // owner's answers are STAFF rows ABOUT the grant, which the CHECK keeps off it.
  if (f.grant) and.push({ OR: [{ supportGrantId: f.grant }, { entityType: 'SupportAccessGrant', entityId: f.grant }] })
  if (f.from) and.push({ occurredAt: { gte: dayStart(f.from, zone) } })
  if (f.to) {
    const next = utcToBusinessDate(new Date(businessDateToUtc(f.to as BusinessDate).getTime() + 86_400_000))
    and.push({ occurredAt: { lt: dayStart(next, zone) } })
  }
  return { AND: and }
}

// ponytail: the records with a page of their own by id alone. Rows about
// anything else name it without a link; SUBJECT_ROUTES (lib/tasks) is the
// fuller map if the audit log needs every record linked.
const RECORD_HREF: Record<string, (id: string) => string> = {
  Property: (id) => `/properties/${id}`,
  Lease: (id) => `/leases/${id}`,
  Ticket: (id) => `/maintenance/${id}`,
  WorkOrder: (id) => `/workorders/${id}`,
  Vendor: (id) => `/vendors/${id}`,
}

export type OrgAuditRow = Awaited<ReturnType<typeof orgAuditRows>>[number]

export async function orgAuditRows(where: Prisma.AuditLogWhereInput, take: number) {
  const rows = await prisma.auditLog.findMany({
    where,
    select: {
      id: true,
      occurredAt: true,
      actorType: true,
      actorRef: true,
      action: true,
      entityType: true,
      entityId: true,
      reason: true,
      supportGrantId: true,
      actorStaff: { select: { name: true } },
      property: { select: { name: true } },
    },
    orderBy: { occurredAt: 'desc' },
    take,
  })
  const adminIds = [...new Set(rows.filter((r) => r.actorType === 'PLATFORM' && r.actorRef).map((r) => r.actorRef!))]
  const admins = new Map(
    (await prisma.platformAdmin.findMany({ where: { id: { in: adminIds } }, select: { id: true, name: true } })).map((a) => [a.id, a.name]),
  )
  return rows.map((r) => ({
    ...r,
    who: whoDid(r, admins),
    href: RECORD_HREF[r.entityType]?.(r.entityId) ?? null,
  }))
}

function whoDid(
  r: { actorType: string; actorRef: string | null; actorStaff: { name: string } | null },
  admins: Map<string, string>,
): string {
  switch (r.actorType) {
    case 'STAFF':
      return r.actorStaff?.name ?? 'A staff member'
    case 'PLATFORM':
      return `Platform support: ${(r.actorRef && admins.get(r.actorRef)) ?? 'unknown admin'}`
    case 'SYSTEM':
      return `System: ${r.actorRef ?? 'unknown job'}`
    default:
      return r.actorType[0] + r.actorType.slice(1).toLowerCase()
  }
}

/// The grant a filter names, for the header (§4.15): only this org's.
export function grantHeader(grantId: string, orgId: string) {
  return prisma.supportAccessGrant.findFirst({
    where: { id: grantId, orgId },
    select: {
      kind: true,
      reason: true,
      startsAt: true,
      expiresAt: true,
      endedAt: true,
      platformAdmin: { select: { name: true } },
      approvedBy: { select: { name: true } },
    },
  })
}
