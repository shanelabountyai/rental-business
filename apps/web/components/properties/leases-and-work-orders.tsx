import { leaseStatusLabel } from '@rental/core/leases'
import { friendlyBusinessDate, friendlyDate, utcToBusinessDate } from '@rental/core/scheduling'
import { WORK_ORDER_STATUS_LABELS } from '@rental/core/workorders'
import { prisma } from '@rental/db'
import Link from 'next/link'

// The Leases and Maintenance sections on the property and unit pages. Both
// pages carried R-009's "Built by R-0xx" placeholders until R-220's demo walk
// read them: a unit with a live tenancy said it had none. Callers have already
// checked the property is in scope; each section checks its own permission.

const LIMIT = 10

type Where = { propertyId: string; unitId?: string }

export async function LeasesSection({
  where,
  showUnit,
  title,
}: {
  where: Where
  showUnit: boolean
  /// PROP-01 and PROP-02 name these sections in their acceptance criteria -
  /// "Leases" on the property, "Lease" on the unit - and e2e asserts both.
  title: string
}) {
  const leases = await prisma.lease.findMany({
    where,
    orderBy: { startsOn: 'desc' },
    take: LIMIT,
    select: {
      id: true,
      status: true,
      startsOn: true,
      endsOn: true,
      unit: { select: { name: true } },
      leaseTenants: {
        orderBy: { isPrimary: 'desc' },
        select: { tenant: { select: { firstName: true, lastName: true } } },
      },
    },
  })

  return (
    <section className="flex flex-col gap-2 rounded-md border p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {leases.length === 0 ? (
        <p className="text-muted-foreground text-sm">No tenancies yet.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm break-words">
          {leases.map((lease) => (
            <li key={lease.id}>
              <Link href={`/leases/${lease.id}`} className="underline underline-offset-4">
                {lease.leaseTenants.map(({ tenant }) => `${tenant.firstName} ${tenant.lastName}`).join(', ') ||
                  'No tenant named'}
              </Link>
              <span className="text-muted-foreground">
                {showUnit && ` · ${lease.unit.name}`} · {leaseStatusLabel(lease.status)} ·{' '}
                {friendlyBusinessDate(utcToBusinessDate(lease.startsOn))}
                {lease.endsOn ? ` to ${friendlyBusinessDate(utcToBusinessDate(lease.endsOn))}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {leases.length === LIMIT && (
        <p className="text-muted-foreground text-xs">The {LIMIT} most recent.</p>
      )}
    </section>
  )
}

export async function MaintenanceSection({
  where,
  zone,
  showUnit,
  excludeIds = [],
}: {
  where: Where
  zone: string
  showUnit: boolean
  /// Jobs a panel ABOVE this one already lists by the same name: the unit
  /// page's turnover panel links every job in the turn, and the property
  /// page's maintenance-spend panel links every CLOSED one. Two links with
  /// one accessible name is an ambiguity for anyone navigating by label -
  /// caught in CI as a strict-mode violation on `turnover.spec.ts` (R-220).
  excludeIds?: string[]
}) {
  const workOrders = await prisma.workOrder.findMany({
    where: { ...where, ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: LIMIT,
    select: { id: true, scope: true, status: true, createdAt: true, unit: { select: { name: true } } },
  })

  return (
    <section className="flex flex-col gap-2 rounded-md border p-4">
      <h2 className="text-sm font-semibold">Maintenance</h2>
      {workOrders.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {excludeIds.length > 0
            ? 'Nothing beyond the jobs listed above.'
            : 'No work orders yet.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm break-words">
          {workOrders.map((workOrder) => (
            <li key={workOrder.id}>
              <Link href={`/workorders/${workOrder.id}`} className="underline underline-offset-4">
                {workOrder.scope}
              </Link>
              <span className="text-muted-foreground">
                {showUnit && ` · ${workOrder.unit.name}`} ·{' '}
                {WORK_ORDER_STATUS_LABELS[workOrder.status] ?? workOrder.status} · opened{' '}
                {friendlyDate(workOrder.createdAt, zone)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {workOrders.length === LIMIT && (
        <p className="text-muted-foreground text-xs">The {LIMIT} most recent.</p>
      )}
    </section>
  )
}
