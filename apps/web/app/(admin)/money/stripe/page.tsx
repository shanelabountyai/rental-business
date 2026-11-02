import { PageHeader } from '@/components/page-header.tsx'
import { ConnectStripeForm } from '@/components/billing/connect-stripe-form.tsx'
import { DEFAULT_ORG_ID } from '@/lib/auth/org.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { connectStripe } from '@/lib/integrations/stripe-actions.ts'
import { collectionRefusal, stripeRow } from '@/lib/integrations/stripe-onboarding.ts'

export const metadata = { title: 'Stripe account' }

// R-277b (PRD 10 §2.2). The org's own Stripe account: where rent is banked,
// whether it may collect, and Stripe's reason when it may not. Owner-only by
// construction (`billing.connect`).

const STATUS_WORDS: Record<string, string> = {
  NOT_STARTED: 'Not connected',
  ONBOARDING: 'Onboarding in progress',
  RESTRICTED: 'Restricted by Stripe',
  ENABLED: 'Connected and collecting',
  DISABLED: 'Disconnected',
}

export default async function StripeAccountPage() {
  const actor = await requirePermission('billing.connect')
  const [row, refusal] = await Promise.all([stripeRow(actor.orgId), collectionRefusal(actor.orgId)])
  const status = row?.status ?? 'NOT_STARTED'
  const platform = actor.orgId === DEFAULT_ORG_ID && !row

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="Stripe account">
        <p className="text-sm text-muted-foreground">
          Rent settles to your own Stripe account. Stripe runs the onboarding and holds your bank details; this
          product never sees them.
        </p>
      </PageHeader>

      <section aria-labelledby="stripe-status" className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <h2 id="stripe-status" className="text-lg font-semibold">
          Status
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 break-words text-sm">
          <dt className="text-muted-foreground">Account</dt>
          <dd className="min-w-0">{platform ? 'The platform account' : STATUS_WORDS[status] ?? status}</dd>
          {row?.accountId && (
            <>
              <dt className="text-muted-foreground">Stripe account id</dt>
              <dd className="min-w-0 font-mono">{row.accountId}</dd>
            </>
          )}
          {row?.statusReason && (
            <>
              <dt className="text-muted-foreground">Stripe says</dt>
              <dd className="min-w-0">{row.statusReason}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Rent collection</dt>
          <dd className="min-w-0">{refusal ? `Off. ${refusal}` : 'On'}</dd>
        </dl>
      </section>

      {!platform && status !== 'ENABLED' && (
        <ConnectStripeForm
          action={connectStripe}
          label={status === 'ONBOARDING' || status === 'RESTRICTED' ? 'Continue Stripe onboarding' : 'Connect Stripe'}
        />
      )}
    </div>
  )
}
