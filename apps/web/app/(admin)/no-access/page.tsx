import Link from 'next/link'
import { requireStaff } from '@/lib/auth/guard.ts'

export const metadata = { title: 'No access — Rental Operations' }

// Where an authenticated staff member lands when they lack a permission.
//
// Before R-007 this case threw out of the guard and Next rendered "This page
// couldn't load" - a crash page for an ordinary, expected outcome. Someone
// following a link from a colleague, or typing a URL from a screenshot, is not
// experiencing a fault; they are experiencing a permission boundary, and the
// product should say which one.
//
// Guarded by requireStaff only. Requiring a permission to see the page that
// explains a missing permission is a redirect loop.
export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ permission?: string; reason?: string }>
}) {
  await requireStaff()
  const { permission, reason } = await searchParams

  return (
    <div className="flex max-w-prose flex-col gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">
        You don&rsquo;t have access to that
      </h1>
      <p className="text-muted-foreground text-sm">
        {reason === 'out_of_scope'
          ? 'Your access covers some properties but not that one. Ask whoever manages access to widen your scope.'
          : 'Your role doesn’t include this. Ask whoever manages access if you need it.'}
      </p>
      {permission && (
        <p className="text-muted-foreground text-sm">
          Missing permission: <code className="font-mono">{permission}</code>
        </p>
      )}
      <p className="text-sm">
        <Link href="/dashboard" className="underline underline-offset-4">
          Back to the dashboard
        </Link>
      </p>
    </div>
  )
}
