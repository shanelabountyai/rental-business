import { randomBytes } from 'node:crypto'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/page-header.tsx'
import { SimulatedQuickBooksConsentForm } from '@/components/billing/quickbooks-forms.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { answerSimulatedQuickBooks } from '@/lib/integrations/quickbooks-actions.ts'
import { orgIdForQuickBooksState } from '@/lib/integrations/quickbooks.ts'

export const metadata = { title: 'Simulated QuickBooks sign-in' }

// R-280 (D-7, D-27): the stand-in for Intuit's consent page. The grant goes
// into the simulator's own table and comes back through the real callback.
// A state another org opened is 404.

export default async function SimulatedQuickBooksPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const actor = await requirePermission('billing.connect')
  const { state } = await searchParams
  if (!state || (await orgIdForQuickBooksState(state)) !== actor.orgId) notFound()
  const submit = answerSimulatedQuickBooks.bind(null, state)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="Simulated QuickBooks sign-in">
        <p className="text-sm text-muted-foreground">
          Stands in for Intuit&apos;s own page. Nothing here reaches QuickBooks. To reconnect, enter the company id this
          entity was connected to.
        </p>
      </PageHeader>
      <SimulatedQuickBooksConsentForm action={submit} suggestedRealm={`sim-${randomBytes(4).toString('hex')}`} />
    </div>
  )
}
