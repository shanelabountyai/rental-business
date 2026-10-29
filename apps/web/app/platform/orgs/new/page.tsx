import { CreateOrgForm } from '@/components/platform/create-org-form.tsx'
import { requirePlatform } from '@/lib/platform/guard.ts'
import { createOrganization } from '@/lib/platform/org-actions.ts'
import Link from 'next/link'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Create an organisation' }

// PRD 11 §4.5 (R-304a, D-323). `org.create` is a step-up permission: holding
// it is enough to see the form, and the press asks for a code.
export default async function CreateOrgPage() {
  await requirePlatform({ permission: 'org.create', view: true })
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Create an organisation</h1>
        <Link href="/platform/orgs" className="text-sm underline underline-offset-4">
          Back to organisations
        </Link>
      </header>
      <p className="text-sm">
        The owner gets a single-use link by email, valid for seven days, to set a password and join. No account
        exists until they accept.
      </p>
      <CreateOrgForm action={createOrganization} />
    </main>
  )
}
