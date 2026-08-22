import { formatCents } from '@rental/core/money'
import { invoiceSplitCategoryLabel } from '@rental/core/vendors'
import { utcToBusinessDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { prisma } from '@rental/db'
import { RecordInvoiceForm } from '@/components/vendor-invoices/record-invoice-form.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { recordVendorInvoice } from '@/lib/vendor-invoices/actions.ts'

export const metadata = { title: 'Vendor invoices — Rental Operations' }

// PAY-10 (R-082): one vendor bill, split across properties and categories.
//
// NO `loading.tsx` HERE OR ABOVE (R-099).
//
// Twenty most recent rather than a paged list: this page exists to record a
// bill and confirm the last few landed, and nobody audits vendor history from
// here - the tax export and the operating report are where the money is read.

const RECENT_LIMIT = 20

export default async function VendorInvoicesPage() {
  const { actor } = await requireScope('vendor.write')
  const scope = await currentScope(actor)

  const entityIds = [...new Set(scope.availableProperties.map((p) => p.legalEntityId))]
  const [vendors, invoices] = await Promise.all([
    prisma.vendor.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.vendorInvoice.findMany({
      // Scoped by SPLIT property: an invoice is visible when at least one of
      // its lines names a property this actor can see. Scoping by the
      // invoice's entity instead would show a bill whose visible share is
      // none of it.
      where: { splits: { some: { propertyId: { in: scope.availableProperties.map((p) => p.id) } } } },
      select: {
        id: true,
        invoiceNumber: true,
        totalCents: true,
        invoicedOn: true,
        paidAt: true,
        vendor: { select: { name: true } },
        legalEntity: { select: { name: true } },
        splits: {
          select: {
            id: true,
            category: true,
            amountCents: true,
            description: true,
            property: { select: { id: true, name: true } },
            workOrderId: true,
          },
        },
      },
      orderBy: { invoicedOn: 'desc' },
      take: RECENT_LIMIT,
    }),
  ])

  const entities = scope.availableEntities.filter((entity) => entityIds.includes(entity.id))

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/money"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Money
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Vendor invoices</h1>
        <p className="text-muted-foreground text-sm">
          The $900 handyman invoice covering three houses. Record it once, split it across the
          properties it actually paid for, and each share lands on that property&rsquo;s P&amp;L and
          Schedule E line.
        </p>
      </header>

      <section aria-labelledby="record-invoice" className="flex flex-col gap-4 rounded-md border p-4">
        <h2 id="record-invoice" className="text-lg font-semibold">
          Record an invoice
        </h2>
        {entities.length === 0 || vendors.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {vendors.length === 0
              ? 'No active vendors yet — add one on the vendors page first.'
              : 'No legal entities in scope.'}
          </p>
        ) : (
          <RecordInvoiceForm
            action={recordVendorInvoice}
            entities={entities}
            properties={scope.availableProperties}
            vendors={vendors}
          />
        )}
      </section>

      <section aria-labelledby="recent-invoices" className="flex flex-col gap-3">
        <h2 id="recent-invoices" className="text-lg font-semibold">
          Recent invoices
        </h2>
        {invoices.length === 0 ? (
          <p className="text-muted-foreground text-sm">None recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {invoices.map((invoice) => (
              <li key={invoice.id} className="flex flex-col gap-2 rounded-md border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {invoice.vendor.name}
                    {invoice.invoiceNumber ? ` · #${invoice.invoiceNumber}` : ''}
                  </span>
                  <span className="tabular-nums font-medium">{formatCents(invoice.totalCents)}</span>
                </div>
                <p className="text-muted-foreground text-xs">
                  {invoice.legalEntity.name} · invoiced {utcToBusinessDate(invoice.invoicedOn)} ·{' '}
                  {invoice.paidAt ? `paid ${utcToBusinessDate(invoice.paidAt)}` : 'not yet paid'}
                </p>
                <ul className="flex flex-col divide-y text-sm">
                  {invoice.splits.map((split) => (
                    <li key={split.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                      <span className="flex flex-col">
                        <Link
                          href={`/properties/${split.property.id}`}
                          className="underline underline-offset-2"
                        >
                          {split.property.name}
                        </Link>
                        <span className="text-muted-foreground text-xs">
                          {invoiceSplitCategoryLabel(split.category)}
                          {split.description ? ` · ${split.description}` : ''}
                          {split.workOrderId ? ' · linked to a work order' : ''}
                        </span>
                      </span>
                      <span className="tabular-nums">{formatCents(split.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
