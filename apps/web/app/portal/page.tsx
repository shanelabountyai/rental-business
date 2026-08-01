import { redirect } from 'next/navigation'
import { auth } from '@/auth.ts'

export const metadata = { title: 'Your home — Rental Operations' }

// Placeholder. R-018 builds the real tenant portal; this exists so R-003 has
// somewhere to prove a magic-link session actually lands, and so the redirect
// for an unauthenticated visitor is exercised by a test.
export default async function TenantPortalPage() {
  const session = await auth()
  if (session?.principal.kind !== 'tenant') redirect('/portal/login')

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        Welcome, {session.principal.name}
      </h1>
      <p className="text-muted-foreground text-sm">
        You are signed in. Your rent, payments, documents and maintenance
        requests appear here once R-018 builds them.
      </p>
    </main>
  )
}
