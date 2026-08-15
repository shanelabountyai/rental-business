import Link from 'next/link'
import { BillingRuns } from '@/components/billing/billing-runs.tsx'
import { WaiverPattern } from '@/components/money/waiver-pattern.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { resyncPayer } from '@/lib/billing/actions.ts'
import { billingRunRows } from '@/lib/billing/lifecycle.ts'
import { billingIsLive, billingProviderName } from '@/lib/billing/provider.ts'
import { waiverPatternByTenant } from '@/lib/ledger/waiver-report.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Money — Rental Operations' }

// Guards itself rather than relying on the layout. The layout proves the
// visitor is staff; this proves they may see THIS section (ROLE-01).
//
// R-036 fills in the Billing Runs half. The rent roll and delinquency aging
// named in PAY-06 live at /money/rent-roll (R-044); this is the operational
// screen for the subscription layer underneath them - what Stripe is actually
// billing, and where it has stopped agreeing with the lease.

export default async function MoneyPage() {
  const actor = await requirePermission('ledger.read')
  const scope = await currentScope(actor)
  const [rows, waiverRows] = await Promise.all([
    billingRunRows(scope.propertyIds),
    waiverPatternByTenant(scope.propertyIds),
  ])

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Money</h1>
        <p className="text-muted-foreground text-sm">
          What Stripe is billing, and where it has stopped agreeing with the
          lease.
        </p>
        <Link
          href="/money/rent-roll"
          className="focus-visible:ring-ring w-fit text-sm underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
        >
          Rent roll and delinquency aging
        </Link>
      </header>

      <BillingRuns
        live={billingIsLive()}
        providerName={billingProviderName()}
        resync={resyncPayer}
        rows={rows.map((row) => ({
          id: row.id,
          leaseId: row.leaseId,
          payerName: row.tenant
            ? `${row.tenant.firstName} ${row.tenant.lastName}`
            : (row.externalPayerName ?? 'Payer'),
          where: `${row.lease.property.name} — ${row.lease.unit.name}`,
          leaseStatus: row.lease.status,
          rentCents: row.lease.rentCents,
          hasSubscription: row.stripeSubscriptionId != null,
          collectionPaused: row.collectionPaused,
          lastSyncedAt: row.lastSyncedAt?.toISOString().slice(0, 16).replace('T', ' ') ?? null,
          lastSyncAction: row.lastSyncAction,
          lastSyncError: row.lastSyncError,
        }))}
      />

      <WaiverPattern rows={waiverRows} />
    </div>
  )
}
