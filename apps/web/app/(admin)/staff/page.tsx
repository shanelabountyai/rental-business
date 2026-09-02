import { ROLE_DEFINITIONS, type RoleKey } from '@rental/core/rbac'
import Link from 'next/link'
import { actorCan, requirePermission } from '@/lib/auth/guard.ts'
import { listStaff } from '@/lib/staff/queries.ts'

export const metadata = { title: 'Staff — Rental Operations' }

// ROLE-04's directory (R-138). `grantAssignment` and `revokeAssignment` have
// existed since R-004 with a comment saying R-007 would build this screen;
// R-007 did not, so until now an owner could not add a colleague, change what
// one could do, or cut off a leaver without a shell on the server.
//
// `staff.read` with NO resource, and the nav entry is `portfolioOnly` to
// match: a StaffUser carries no `propertyId`, so there is no scope to narrow
// the directory by - the same posture Vendors and Jurisdiction rules take.
export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>
}) {
  await requirePermission('staff.read')
  const includeInactive = (await searchParams).show === 'all'
  const [staff, canManage] = await Promise.all([
    listStaff({ includeInactive }),
    actorCan('staff.manage'),
  ])

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Staff</h1>
        {canManage && (
          <Link
            href="/staff/new"
            className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Add staff member
          </Link>
        )}
      </div>

      <ul className="flex flex-col divide-y rounded-md border">
        {staff.map((member) => {
          const roles = member.assignments.map((assignment) => {
            const key = assignment.role.key as RoleKey
            const name = ROLE_DEFINITIONS[key]?.name ?? assignment.role.name
            const scope =
              assignment.property?.name ?? assignment.legalEntity?.name ?? 'all properties'
            return `${name} · ${scope}`
          })
          return (
            <li key={member.id}>
              <Link
                href={`/staff/${member.id}`}
                className="hover:bg-secondary focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
              >
                <span className="font-medium">
                  {member.name}
                  {!member.active && <span className="text-muted-foreground"> (deactivated)</span>}
                </span>
                <span className="text-muted-foreground text-sm">
                  {member.email} ·{' '}
                  {roles.length > 0 ? roles.join(', ') : 'no active access'}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>

      <Link
        href={includeInactive ? '/staff' : '/staff?show=all'}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
      >
        {includeInactive ? 'Hide deactivated people' : 'Show deactivated people too'}
      </Link>
    </div>
  )
}
