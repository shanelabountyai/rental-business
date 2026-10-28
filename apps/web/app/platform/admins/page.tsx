import { PLATFORM_ROLE_DEFINITIONS, type PlatformRoleKey } from '@rental/core/rbac'
import { friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { requirePlatform } from '@/lib/platform/guard.ts'
import Link from 'next/link'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Platform admins' }

// PRD 11 §4.8 (R-302b). Reading needs `platformAdmin.manage`, not a fresh
// code: the code is asked for on each act (`view`, D-367).
export default async function PlatformAdminsPage() {
  await requirePlatform({ permission: 'platformAdmin.manage', view: true })
  const admins = await prisma.platformAdmin.findMany({
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      email: true,
      active: true,
      credential: { select: { mfaEnrolledAt: true, lastLoginAt: true } },
      roles: { where: { revokedAt: null }, select: { roleKey: true } },
    },
  })

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Platform admins</h1>
        <a href="/platform" className="text-sm underline underline-offset-4">
          Back to the console
        </a>
      </header>
      <Link href="/platform/admins/new" className="w-fit text-sm font-medium underline underline-offset-4">
        Invite an admin
      </Link>
      <ul className="flex flex-col divide-y rounded-md border">
        {admins.map((admin) => (
          <li key={admin.id} className="flex flex-col gap-1 px-4 py-3 text-sm break-words">
            <Link href={`/platform/admins/${admin.id}`} className="font-medium underline underline-offset-4">
              {admin.name}
            </Link>
            <span>{admin.email}</span>
            <span className="text-muted-foreground">
              {admin.active ? 'Active' : 'Deactivated'} ·{' '}
              {admin.roles.map((r) => PLATFORM_ROLE_DEFINITIONS[r.roleKey as PlatformRoleKey]?.name ?? r.roleKey).join(', ') || 'No roles'} ·{' '}
              {admin.credential?.mfaEnrolledAt ? 'Two-factor set up' : 'Two-factor not set up'} · last sign-in{' '}
              {admin.credential?.lastLoginAt ? friendlyTimestamp(admin.credential.lastLoginAt, 'UTC') : 'never'}
            </span>
          </li>
        ))}
      </ul>
    </main>
  )
}
