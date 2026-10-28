import { isPlatformPermission } from '@rental/core/rbac'
import { requirePlatform } from '@/lib/platform/guard.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'No access' }

// Where `requirePlatform` sends an admin whose roles do not carry the
// permission (R-302a). Session only: every admin may be told why.
export default async function PlatformNoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ permission?: string }>
}) {
  await requirePlatform()
  const { permission } = await searchParams
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">You don’t have access to that</h1>
      <p className="text-sm break-words">
        {permission && isPlatformPermission(permission)
          ? `It needs the ${permission} permission, which none of your platform roles carries.`
          : 'None of your platform roles carries the permission it needs.'}{' '}
        A platform owner can change your roles.
      </p>
      <a href="/platform" className="text-sm underline underline-offset-4">
        Back to the console
      </a>
    </main>
  )
}
