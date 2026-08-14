import Link from 'next/link'
import { notFound } from 'next/navigation'
import { UtilityBillsPanel } from '@/components/billing/utility-bills-panel.tsx'
import { actorCan, propertyResource, requireScope } from '@/lib/auth/guard.ts'
import { utilityBillsForProperty, utilityLabel } from '@/lib/billing/rubs.ts'
import { recordUtilityBill, splitUtilityBill } from '@/lib/billing/rubs-actions.ts'
import { listDocuments } from '@/lib/documents/queries.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { getPropertyDetail } from '@/lib/properties/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Utility bills — Rental Operations' }

// One meter, several units (PAY-08, R-042).
//
// Its own route rather than another section on the property page, because
// this is the one screen in the product where a single press bills every
// tenant at a property - and it needs room to show the split, the bill it
// came from, and the jurisdiction rule that permits it at all.
//
// NO `loading.tsx` HERE OR ABOVE. This page calls `notFound()` for a property
// outside your scope, and ROLE-01 answers 404 rather than 403 deliberately -
// a Suspense boundary above it would stream a 200 before the page ran and
// turn every scoping test in this product green for the wrong reason (R-099).

export default async function PropertyUtilitiesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { actor } = await requireScope('property.read')
  const scope = await currentScope(actor)

  const property = await getPropertyDetail(id, scope)
  if (!property) notFound()

  const resource = propertyResource(property)
  const [canRecord, canSplit, documents, bills] = await Promise.all([
    actorCan('property.write', resource),
    // Splitting bills every tenant at the property in one press, so it sits
    // behind the privileged permission rather than beside the bookkeeping.
    actorCan('ledger.adjust', resource),
    listDocuments(id, scope),
    utilityBillsForProperty(id),
  ])

  // D-4: whether a bill may be split at all is a versioned, effective-dated
  // fact about the state, read here so the screen can say so before anybody
  // fills a form in. A state with no rule configured is a real gap, and null
  // says so rather than defaulting to yes.
  const rule = await rulesFor(
    { state: property.state, county: property.county },
    new Date(),
  ).catch(() => null)

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href={`/properties/${id}`}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← {property.name}
        </Link>
        {/* NOT "Utility bills" — the panel below carries that as its own
            section heading, and two headings with the same accessible name on
            one page is a screen reader announcing the same landmark twice. */}
        <h1 className="text-2xl font-semibold tracking-tight">Utilities</h1>
        <p className="text-muted-foreground text-sm">
          For a property on one meter: record the bill, check the split, then
          charge it on.
        </p>
      </header>

      <UtilityBillsPanel
        canRecord={canRecord}
        canSplit={canSplit}
        rubsPermitted={rule ? rule.rubsPermitted : null}
        state={property.state}
        // Bound server-side. A plain function cannot cross this boundary and
        // `npm run build` does not catch the difference.
        record={recordUtilityBill.bind(null, id)}
        split={splitUtilityBill}
        documents={documents.map((doc) => ({
          id: doc.id,
          label: `${doc.fileName} (${doc.type.toLowerCase().replace(/_/g, ' ')})`,
        }))}
        bills={bills.map((bill) => ({
          id: bill.id,
          utilityType: bill.utilityType,
          utilityLabel: utilityLabel(bill.utilityType),
          provider: bill.provider,
          // `@db.Date` values, sliced off the ISO string. They are calendar
          // days and no zone may touch them.
          periodStart: bill.periodStart.toISOString().slice(0, 10),
          periodEnd: bill.periodEnd.toISOString().slice(0, 10),
          amountCents: bill.amountCents,
          method: bill.method,
          allocatedAt: bill.allocatedAt ? bill.allocatedAt.toISOString().slice(0, 10) : null,
          allocatedByName: bill.allocatedBy?.name ?? null,
          landlordCents: bill.landlordCents,
          documentId: bill.documentId,
          shares: bill.charges.map((charge) => ({
            id: charge.id,
            unitName: charge.lease.unit.name,
            amountCents: charge.amountCents,
            description: charge.description,
          })),
        }))}
      />
    </div>
  )
}
