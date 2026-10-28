import {
  PLATFORM_ROLE_DEFINITIONS,
  type PlatformRoleKey,
  platformDeactivationRefusal,
  platformGrantRefusal,
  platformMfaResetRefusal,
  platformRevokeRefusal,
  platformSetupLinkRefusal,
} from '@rental/core/rbac'
import { friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { notFound } from 'next/navigation'
import { PlatformAdminControls } from '@/components/platform/platform-admin-controls.tsx'
import { managePlatformAdmin } from '@/lib/platform/admin-actions.ts'
import { requirePlatform } from '@/lib/platform/guard.ts'
import Link from 'next/link'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Platform admin' }

const roleName = (key: string) => PLATFORM_ROLE_DEFINITIONS[key as PlatformRoleKey]?.name ?? key
const when = (at: Date) => friendlyTimestamp(at, 'UTC')

export default async function PlatformAdminPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePlatform({ permission: 'platformAdmin.manage', view: true })
  const { id } = await params
  const admin = await prisma.platformAdmin.findUnique({
    where: { id },
    include: {
      credential: { select: { mfaEnrolledAt: true, lastLoginAt: true } },
      roles: {
        orderBy: { grantedAt: 'desc' },
        include: { grantedBy: { select: { name: true } }, revokedBy: { select: { name: true } } },
      },
    },
  })
  if (!admin) notFound()

  // The whole deployment's live grants: the last-owner rule is about all of them.
  const live = (
    await prisma.platformRoleAssignment.findMany({
      where: { revokedAt: null },
      select: { id: true, platformAdminId: true, roleKey: true, revokedAt: true, platformAdmin: { select: { active: true } } },
    })
  ).map(({ platformAdmin, ...row }) => ({ ...row, adminActive: platformAdmin.active }))
  const summary = { ...admin, mfaEnrolledAt: admin.credential?.mfaEnrolledAt ?? null }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight break-words">{admin.name}</h1>
        <Link href="/platform/admins" className="text-sm underline underline-offset-4">
          Back to platform admins
        </Link>
      </header>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm break-words sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Email</dt>
        <dd>{admin.email}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>{admin.active ? 'Active' : `Deactivated ${admin.deactivatedAt ? when(admin.deactivatedAt) : ''}`}</dd>
        <dt className="text-muted-foreground">Two-factor set up</dt>
        <dd>{summary.mfaEnrolledAt ? when(summary.mfaEnrolledAt) : 'Not set up'}</dd>
        <dt className="text-muted-foreground">Last sign-in</dt>
        <dd>{admin.credential?.lastLoginAt ? when(admin.credential.lastLoginAt) : 'Never'}</dd>
      </dl>
      <PlatformAdminControls
        action={managePlatformAdmin}
        adminId={admin.id}
        adminName={admin.name}
        roleOptions={Object.entries(PLATFORM_ROLE_DEFINITIONS).map(([value, role]) => ({ value, label: role.name }))}
        assignments={admin.roles.map((row) => ({
          id: row.id,
          roleName: roleName(row.roleKey),
          grantedLabel: `${when(row.grantedAt)}${row.grantedBy ? ` by ${row.grantedBy.name}` : ''}`,
          revokedLabel: row.revokedAt ? `${when(row.revokedAt)}${row.revokedBy ? ` by ${row.revokedBy.name}` : ''}` : null,
          revokeRefusal: row.revokedAt ? null : platformRevokeRefusal(row.id, live),
        }))}
        refusals={{
          grant: platformGrantRefusal(admin.id, actor.id) ?? (admin.active ? null : `${admin.name} is deactivated.`),
          resetMfa: platformMfaResetRefusal(summary, actor.id),
          deactivate: admin.active ? platformDeactivationRefusal(admin.id, actor.id, live) : `${admin.name} is already deactivated.`,
          resend: platformSetupLinkRefusal(summary),
        }}
      />
    </main>
  )
}
