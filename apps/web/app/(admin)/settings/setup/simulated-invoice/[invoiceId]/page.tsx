import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/page-header.tsx'
import { ConnectStripeForm } from '@/components/billing/connect-stripe-form.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { billingIsLive } from '@/lib/billing/provider.ts'
import { paySimulatedTestInvoice } from '@/lib/setup/actions.ts'

export const metadata = { title: 'Simulated Stripe invoice' }

// R-291b (D-27): the stand-in for Stripe's hosted invoice page, which the
// simulated provider's setup test invoice points at. "Pay" comes back as the
// paid `invoice.updated`, through the pipeline. Gone once a key is set.
export default async function SimulatedSetupInvoicePage({ params }: { params: Promise<{ invoiceId: string }> }) {
  await requirePermission('billing.connect')
  const { invoiceId } = await params
  if (billingIsLive() || !invoiceId.startsWith('in_simsetup')) notFound()
  const pay = paySimulatedTestInvoice.bind(null, invoiceId)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title="Simulated Stripe invoice">
        <p className="text-sm text-muted-foreground">
          Stands in for Stripe&apos;s own invoice page. Nothing here reaches Stripe, and no card details are asked for.
        </p>
      </PageHeader>
      <p className="text-sm break-words">Setup test payment: $1.00</p>
      <ConnectStripeForm action={pay} label="Pay $1.00" />
    </div>
  )
}
