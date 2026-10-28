import 'server-only'

import { type Prisma, prisma } from '@rental/db'

// `/platform/audit` and its CSV (PRD 11 §4.9, R-303b): the platform's own
// acts. `actorType = PLATFORM` is the whole filter, because the CHECK on
// `AuditLog` (D-352) allows an org-less row only for a PLATFORM actor, so
// "every org-less row" is already inside it. Org staff's rows never show.
// The grant column waits for R-295, which adds `supportGrantId`.

export type AuditFilters = { admin: string; org: string; action: string; from: string; to: string }

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function auditFilters(params: Record<string, string | string[] | undefined>): AuditFilters {
  const one = (key: string) => {
    const v = params[key]
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? ''
  }
  return { admin: one('admin'), org: one('org'), action: one('action'), from: one('from'), to: one('to') }
}

/// Dates are UTC days, the way the rows are stored; `to` includes its day.
/// A malformed date is ignored rather than refused, as a GET filter is.
export function auditWhere(f: AuditFilters): Prisma.AuditLogWhereInput {
  const occurredAt: Prisma.DateTimeFilter = {}
  if (DATE.test(f.from)) occurredAt.gte = new Date(`${f.from}T00:00:00Z`)
  if (DATE.test(f.to)) occurredAt.lt = new Date(new Date(`${f.to}T00:00:00Z`).getTime() + 86_400_000)
  return {
    actorType: 'PLATFORM',
    ...(f.admin && { actorRef: f.admin }),
    ...(f.org === 'none' ? { orgId: null } : f.org ? { organization: { slug: f.org } } : {}),
    ...(f.action && { action: f.action }),
    ...((occurredAt.gte || occurredAt.lt) && { occurredAt }),
  }
}

export async function platformAuditRows(f: AuditFilters, take: number) {
  const rows = await prisma.auditLog.findMany({
    where: auditWhere(f),
    select: {
      id: true,
      occurredAt: true,
      actorRef: true,
      action: true,
      entityType: true,
      entityId: true,
      reason: true,
      organization: { select: { slug: true, name: true } },
    },
    orderBy: { occurredAt: 'desc' },
    take,
  })
  const ids = [...new Set(rows.map((r) => r.actorRef).filter((id): id is string => Boolean(id)))]
  const admins = await prisma.platformAdmin.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })
  const byId = new Map(admins.map((a) => [a.id, a]))
  return rows.map((r) => ({ ...r, admin: r.actorRef ? byId.get(r.actorRef) ?? null : null }))
}
