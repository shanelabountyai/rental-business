import 'server-only'

import type { Permission } from '@rental/core/rbac'
import type { TaskSubjectType } from '@rental/core/tasks'
import { prisma } from '@rental/db'
import { actorCan, propertyResource } from '@/lib/auth/guard.ts'

// R-195. Where a Task's subject lives, for every subject type a producer
// writes. A `Record` over core's union rather than a switch with a default:
// a new subject type does not typecheck until it has a row here, which is
// the gap five items in a row each left to somebody else.
//
// `permission` is the one the TARGET page's own guard requires, checked
// against the task's property the way every subject read on /tasks/[id]
// already was: a role that cannot open the page is not handed its address
// (ROLE-01, hide don't just block). The page itself still answers 404 for a
// record outside scope.
//
// `null` is a subject with nowhere to go. An ad-hoc task has no entity, and a
// `serve_notice_offline` task's subjectId is the notification's idempotency
// key rather than a row id - its printable link is the destination.

interface Subject {
  id: string
  propertyId: string
}

interface SubjectRoute {
  permission: Permission
  /// /jobs is guarded by a resource-less `requirePermission('job.manage')`,
  /// which only a portfolio-wide grant satisfies.
  portfolioWide?: true
  label: string
  /// In input order, null where the row the address needs is gone. One query
  /// per subject type however many tasks share it: `/tasks` renders every
  /// open task in scope, and hundreds of them can be showings.
  hrefs: (subjects: Subject[]) => (string | null)[] | Promise<(string | null)[]>
}

export interface SubjectLink {
  href: string
  label: string
}

const direct = (path: (id: string) => string) => (subjects: Subject[]) =>
  subjects.map((subject) => path(subject.id))

const ids = (subjects: Subject[]) => ({ id: { in: subjects.map((subject) => subject.id) } })

async function byId<T extends { id: string }>(
  rows: Promise<T[]>,
  subjects: Subject[],
  path: (row: T) => string,
): Promise<(string | null)[]> {
  const found = new Map((await rows).map((row) => [row.id, row]))
  return subjects.map((subject) => {
    const row = found.get(subject.id)
    return row ? path(row) : null
  })
}

export const SUBJECT_ROUTES: Record<TaskSubjectType, SubjectRoute | null> = {
  AdHoc: null,
  Notification: null,

  Lease: { permission: 'lease.read', label: 'Open the lease', hrefs: direct((id) => `/leases/${id}`) },
  Ticket: { permission: 'ticket.read', label: 'Open the ticket', hrefs: direct((id) => `/maintenance/${id}`) },
  WorkOrder: { permission: 'workorder.read', label: 'Open the work order', hrefs: direct((id) => `/workorders/${id}`) },
  EvictionCase: { permission: 'eviction.manage', label: 'Open the eviction case', hrefs: direct((id) => `/evictions/${id}`) },
  AbandonmentCase: { permission: 'eviction.manage', label: 'Open the abandonment case', hrefs: direct((id) => `/abandonment/${id}`) },
  ViolationCase: { permission: 'lease.read', label: 'Open the violation case', hrefs: direct((id) => `/violations/${id}`) },
  InsuranceClaim: { permission: 'property.read', label: 'Open the insurance claim', hrefs: direct((id) => `/claims/${id}`) },
  ComplianceItem: { permission: 'property.read', label: 'Open the compliance item', hrefs: direct((id) => `/compliance/${id}`) },
  Inspection: { permission: 'inspection.read', label: 'Open the inspection', hrefs: direct((id) => `/inspections/${id}`) },
  Thread: { permission: 'message.read', label: 'Open the conversation', hrefs: direct((id) => `/messages/${id}`) },
  JobRun: { permission: 'job.manage', portfolioWide: true, label: 'Open scheduled jobs', hrefs: direct(() => '/jobs') },

  // R-170's link, now one row of this table. The disbursement form needs the
  // letter, the totals and the deduction list around it, all on that screen.
  Deposit: {
    permission: 'lease.read',
    label: 'Open the deposit disposition',
    hrefs: (s) =>
      byId(prisma.deposit.findMany({ where: ids(s), select: { id: true, leaseId: true } }), s, (row) => `/leases/${row.leaseId}/deposit`),
  },
  // The four below live in panels on a parent's page, so the address is the
  // parent's with the panel's own heading id as the fragment.
  AccommodationRequest: {
    permission: 'lease.read',
    label: 'Open the accommodation request',
    hrefs: (s) =>
      byId(prisma.accommodationRequest.findMany({ where: ids(s), select: { id: true, leaseId: true } }), s, (row) => `/leases/${row.leaseId}#accommodations`),
  },
  RenterInsurancePolicy: {
    permission: 'lease.read',
    label: "Open the renter's insurance",
    hrefs: (s) =>
      byId(prisma.renterInsurancePolicy.findMany({ where: ids(s), select: { id: true, leaseId: true } }), s, (row) => `/leases/${row.leaseId}#renter-insurance`),
  },
  LeasePartyChange: {
    permission: 'lease.read',
    label: 'Open the party change',
    hrefs: (s) =>
      byId(prisma.leasePartyChange.findMany({ where: ids(s), select: { id: true, leaseId: true } }), s, (row) => `/leases/${row.leaseId}#party-change`),
  },
  TurnoverProject: {
    permission: 'unit.read',
    label: 'Open the turn',
    hrefs: (s) =>
      byId(
        prisma.turnoverProject.findMany({ where: ids(s), select: { id: true, propertyId: true, unitId: true } }),
        s,
        (row) => `/properties/${row.propertyId}/units/${row.unitId}#turnover`,
      ),
  },
  Showing: {
    permission: 'lease.read',
    label: "Open the prospect's showings",
    hrefs: (s) =>
      byId(prisma.showing.findMany({ where: ids(s), select: { id: true, prospectId: true } }), s, (row) => `/prospects/${row.prospectId}#showings`),
  },
  Unit: {
    permission: 'unit.read',
    label: 'Open the unit',
    hrefs: (s) =>
      byId(prisma.unit.findMany({ where: ids(s), select: { id: true, propertyId: true } }), s, (row) => `/properties/${row.propertyId}/units/${row.id}`),
  },
  // No tenant page exists; the lease on the task's own property is where the
  // tenant's contact details are read (a bounce task says "confirm their
  // address"). The newest one, for a tenant who has renewed into a new lease.
  Tenant: {
    permission: 'lease.read',
    label: "Open the tenant's lease",
    hrefs: async (s) => {
      const rows = await prisma.leaseTenant.findMany({
        where: {
          tenantId: { in: s.map((subject) => subject.id) },
          lease: { propertyId: { in: s.map((subject) => subject.propertyId) } },
        },
        select: { tenantId: true, leaseId: true, lease: { select: { propertyId: true } } },
        orderBy: { createdAt: 'desc' },
      })
      return s.map((subject) => {
        const row = rows.find(
          (r) => r.tenantId === subject.id && r.lease.propertyId === subject.propertyId,
        )
        return row ? `/leases/${row.leaseId}` : null
      })
    },
  },
}

/**
 * The link to each task's subject, in input order, or null where there is
 * none or the viewer may not open it.
 */
export async function subjectLinks(
  tasks: readonly {
    subjectType: string
    subjectId: string
    property: { id: string; legalEntityId: string }
  }[],
): Promise<(SubjectLink | null)[]> {
  const links: (SubjectLink | null)[] = tasks.map(() => null)
  const groups = new Map<string, number[]>()
  tasks.forEach((task, i) => groups.set(task.subjectType, [...(groups.get(task.subjectType) ?? []), i]))

  await Promise.all(
    [...groups].map(async ([subjectType, indexes]) => {
      // A string no producer writes (the demo seed goes straight to Prisma)
      // has no route and no link.
      const route = SUBJECT_ROUTES[subjectType as TaskSubjectType]
      if (!route) return
      const allowed: number[] = []
      for (const i of indexes) {
        const resource = route.portfolioWide ? {} : propertyResource(tasks[i]!.property)
        if (await actorCan(route.permission, resource)) allowed.push(i)
      }
      if (allowed.length === 0) return
      const hrefs = await route.hrefs(
        allowed.map((i) => ({ id: tasks[i]!.subjectId, propertyId: tasks[i]!.property.id })),
      )
      allowed.forEach((i, n) => {
        const href = hrefs[n]
        if (href) links[i] = { href, label: route.label }
      })
    }),
  )
  return links
}
