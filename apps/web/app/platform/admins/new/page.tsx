import { PLATFORM_ROLE_DEFINITIONS } from '@rental/core/rbac'
import { InvitePlatformAdminForm } from '@/components/platform/invite-platform-admin-form.tsx'
import { invitePlatformAdmin } from '@/lib/platform/admin-actions.ts'
import { requirePlatform } from '@/lib/platform/guard.ts'
import Link from 'next/link'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Invite a platform admin' }

export default async function InvitePlatformAdminPage() {
  await requirePlatform({ permission: 'platformAdmin.manage', view: true })
  const roleOptions = Object.entries(PLATFORM_ROLE_DEFINITIONS).map(([value, role]) => ({ value, label: role.name }))
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Invite a platform admin</h1>
        <Link href="/platform/admins" className="text-sm underline underline-offset-4">
          Back to platform admins
        </Link>
      </header>
      <p className="text-sm">
        They get a single-use link by email to set a password, then set up two-factor at first sign-in.
      </p>
      <InvitePlatformAdminForm action={invitePlatformAdmin} roleOptions={roleOptions} />
    </main>
  )
}
