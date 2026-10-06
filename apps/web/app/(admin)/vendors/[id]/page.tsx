import { formatCents } from '@rental/core/money'
import { requiresForm1099 } from '@rental/core/vendors'
import Link from 'next/link'
import { Fragment } from 'react'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/page-header.tsx'
import { TaskActionButton } from '@/components/tasks/action-button.tsx'
import { VendorRecordForm } from '@/components/vendors/vendor-record-form.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { deactivateVendor, saveVendorRecord } from '@/lib/vendors/staff-actions.ts'
import { getVendor, vendorPaymentTotalsForYear } from '@/lib/vendors/staff-queries.ts'
import { Panel } from '@/components/panel.tsx'

export const metadata = { title: 'Vendor — Rental Operations' }

// NO `loading.tsx` HERE OR ABOVE (R-099): this page calls notFound().
export default async function VendorPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  await requirePermission('vendor.read')
  const vendor = await getVendor(id)
  if (!vendor) notFound()

  const year = new Date().getUTCFullYear()
  const totals = await vendorPaymentTotalsForYear(vendor.id, year)

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/vendors"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Vendors
        </Link>
        <PageHeader title={vendor.name} />
      </header>

      <Panel variant="boxed" headingId="totals" title={<>Paid in {year}</>} gap="gap-2">
        {totals.totalCents === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing paid yet this year.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {Object.entries(totals.byMethod).map(([method, cents]) => (
              <Fragment key={method}>
                <dt className="text-muted-foreground">{method}</dt>
                <dd>{formatCents(cents)}</dd>
              </Fragment>
            ))}
            <dt className="font-medium">Total</dt>
            <dd className="font-medium">{formatCents(totals.totalCents)}</dd>
          </dl>
        )}
        {requiresForm1099(totals.totalCents) && (
          <p className="text-sm text-warning">
            $600 or more paid this year — a 1099-NEC candidate.
          </p>
        )}
      </Panel>

      <VendorRecordForm
        action={saveVendorRecord.bind(null, vendor.id)}
        submitLabel="Save"
        defaults={{
          name: vendor.name,
          trades: vendor.trades.join(', '),
          contactName: vendor.contactName ?? '',
          email: vendor.email ?? '',
          phone: vendor.phone ?? '',
          serviceAreas: vendor.serviceAreas.join(', '),
          licenseNumber: vendor.licenseNumber ?? '',
          w9OnFile: vendor.w9OnFile,
          coiExpiresOn: vendor.coiExpiresOn?.toISOString().slice(0, 10) ?? '',
          preferredRank: vendor.preferredRank ?? '',
          emergencyAvailable: vendor.emergencyAvailable,
        }}
      />

      {vendor.active && (
        <TaskActionButton action={deactivateVendor.bind(null, vendor.id)} label="Deactivate" />
      )}
    </div>
  )
}
