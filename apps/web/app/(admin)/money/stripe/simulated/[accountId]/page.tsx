import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/page-header.tsx'
import { SimulatedOnboardingForm } from '@/components/billing/connect-stripe-form.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { orgIdForStripeAccount } from '@/lib/integrations/store.ts'
import { submitSimulatedStripe } from '@/lib/integrations/stripe-actions.ts'

export const metadata = { title: 'Simulated Stripe onboarding' }

// R-277b (D-7, D-27): the stand-in for Stripe's hosted onboarding, which the
// simulated connector's Account Link points at. Its answer goes into the
// simulator's own table and comes back as `account.updated`, so the status
// page learns it the way it would from Stripe. Another org's account is 404.

export default async function SimulatedStripeOnboardingPage({ params }: { params: Promise<{ accountId: string }> }) {
  const actor = await requirePermission('billing.connect')
  const { accountId } = await params
  if ((await orgIdForStripeAccount(accountId)) !== actor.orgId) notFound()
  const submit = submitSimulatedStripe.bind(null, accountId)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="Simulated Stripe onboarding">
        <p className="text-sm text-muted-foreground">
          Stands in for Stripe&apos;s own pages. Nothing here reaches Stripe, and no bank details are asked for.
        </p>
      </PageHeader>
      <SimulatedOnboardingForm action={submit} />
    </div>
  )
}
