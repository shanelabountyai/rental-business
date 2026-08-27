import { friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
import { filingCabinetAlertsDue } from '@/lib/filing-cabinet/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Renewals & alerts — Rental Operations' }

const KIND_LABELS: Record<string, string> = {
  ARM_ADJUSTMENT: 'ARM rate adjustment',
  BALLOON_MATURITY: 'Balloon maturity',
  INSURANCE_RENEWAL: 'Insurance renewal',
}

// The dashboard's "Renewals & alerts" tile drilling into a real list
// (R-050, RPT-01). DELIBERATELY NOT LABELED "Compliance" - see
// lib/dashboard/queries.ts's header. `filingCabinetAlertsDue()` covers
// mortgage ARM/balloon dates and insurance renewals only, not the statutory
// compliance calendar R-077 is reserved for. It was written and tested at
// R-015 and had no caller until this page.
export default async function RenewalsPage() {
  const { actor } = await requireScope('property.read')
  const scope = await currentScope(actor)
  const alerts = await filingCabinetAlertsDue(scope, new Date())
  const propertyName = (propertyId: string) =>
    scope.availableProperties.find((p) => p.id === propertyId)?.name ?? 'Unknown property'
  const sorted = [...alerts].sort((a, b) => a.dueOn.getTime() - b.dueOn.getTime())

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/dashboard"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Renewals & alerts</h1>
        <p className="text-muted-foreground text-sm">
          Mortgage rate adjustments, balloon maturities and insurance renewals due within
          30 days. Not a statutory compliance calendar — permits, certificates and mandated
          inspections aren&apos;t tracked here yet.
        </p>
      </header>

      {sorted.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing due in the next 30 days.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {sorted.map((alert, i) => (
            <li key={`${alert.propertyId}-${alert.kind}-${i}`}>
              <Link
                href={`/properties/${alert.propertyId}`}
                className="hover:bg-accent focus-visible:ring-ring flex min-h-11 flex-col gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none sm:flex-row sm:items-baseline sm:justify-between"
              >
                <span className="font-medium">
                  {propertyName(alert.propertyId)} — {KIND_LABELS[alert.kind] ?? alert.kind}
                  {alert.mortgage && ` (${alert.mortgage.lender})`}
                  {alert.insurancePolicy && ` (${alert.insurancePolicy.carrier})`}
                </span>
                <span className="text-muted-foreground text-sm tabular-nums">
                  Due {friendlyBusinessDate(utcToBusinessDate(alert.dueOn))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
