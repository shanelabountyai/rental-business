import { ROLE_DEFINITIONS, type RoleKey } from '@rental/core/rbac'
import { friendlyDate } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { StaffControls } from '@/components/staff/staff-controls.tsx'
import { actorCan, requirePermission } from '@/lib/auth/guard.ts'
import { manageStaff } from '@/lib/staff/actions.ts'
import { roleOptions, scopeOptions } from '@/lib/staff/options.ts'
import { staffDetail } from '@/lib/staff/queries.ts'

export const metadata = { title: 'Staff member — Rental Operations' }

/// A staff member hangs off no property, so there is no property-local zone to
/// print these in. The first property by name is the closest available answer
/// and is the same choice the announcement history already makes for the same
/// reason - a portfolio-wide screen with a silent server zone (UTC on Vercel)
/// is the defect R-115 fixed there.
async function portfolioZone(): Promise<string> {
  const property = await prisma.property.findFirst({
    where: { active: true },
    orderBy: { name: 'asc' },
    select: { timezone: true },
  })
  return property?.timezone ?? 'UTC'
}

const dollars = (cents: number | null): string =>
  cents === null ? '' : (cents / 100).toFixed(2)

export default async function StaffMemberPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requirePermission('staff.read')
  const { id } = await params
  const [member, canManage, zone, scopes] = await Promise.all([
    staffDetail(id),
    actorCan('staff.manage'),
    portfolioZone(),
    scopeOptions(),
  ])
  if (!member) notFound()

  const assignments = member.assignments.map((assignment) => {
    const key = assignment.role.key as RoleKey
    return {
      id: assignment.id,
      roleName: ROLE_DEFINITIONS[key]?.name ?? assignment.role.name,
      scopeLabel:
        assignment.property?.name ?? assignment.legalEntity?.name ?? 'all properties',
      grantedLabel: friendlyDate(assignment.grantedAt, zone),
      revokedLabel: assignment.revokedAt ? friendlyDate(assignment.revokedAt, zone) : null,
      grantedByName: assignment.grantedBy?.name ?? null,
    }
  })

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/staff"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Staff
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{member.name}</h1>
        <p className="text-muted-foreground text-sm">
          {member.email}
          {member.active
            ? ''
            : ` · deactivated ${member.deactivatedAt ? friendlyDate(member.deactivatedAt, zone) : ''}`}
          {member.credential?.mfaEnrolledAt
            ? ' · two-factor enrolled'
            : ' · no second factor enrolled'}
        </p>
      </header>

      {canManage ? (
        <StaffControls
          action={manageStaff.bind(null, member.id)}
          staffName={member.name}
          active={member.active}
          assignments={assignments}
          roleOptions={roleOptions()}
          scopeOptions={scopes}
          approveWorkOrderDollars={dollars(member.approveWorkOrderCents)}
          waiveFeeDollars={dollars(member.waiveFeeCents)}
        />
      ) : (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Current access</h2>
          <ul className="flex flex-col divide-y rounded-md border">
            {assignments
              .filter((a) => a.revokedLabel === null)
              .map((row) => (
                <li key={row.id} className="flex flex-col px-4 py-3">
                  <span className="font-medium">{row.roleName}</span>
                  <span className="text-muted-foreground text-sm">
                    {row.scopeLabel} · granted {row.grantedLabel}
                  </span>
                </li>
              ))}
          </ul>
          <p className="text-muted-foreground text-sm">
            Changing access needs the Owner role.
          </p>
        </section>
      )}
    </div>
  )
}
