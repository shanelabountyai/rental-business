import { complianceItemTypeLabel } from '@rental/core/compliance'
import { friendlyDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { RecordCompletionForm } from '@/components/compliance/record-completion-form.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import { recordCompletion } from '@/lib/compliance/actions.ts'
import { getComplianceItem } from '@/lib/compliance/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Compliance item — Rental Operations' }

// NO `loading.tsx` HERE OR ABOVE (R-099): this page calls notFound() for a
// record outside scope, and a Suspense boundary above would stream a 200
// before it ran.
export default async function ComplianceItemPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { actor } = await requireScope('property.read')
  const scope = await currentScope(actor)
  const item = await getComplianceItem(id, scope)
  if (!item) notFound()

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/compliance"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Compliance calendar
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{item.label}</h1>
        <p className="text-muted-foreground text-sm">
          {complianceItemTypeLabel(item.type)} · {item.property?.name ?? item.legalEntity?.name} · due{' '}
          {friendlyDate(item.dueOn, 'UTC')}
          {item.recurrenceMonths != null && ` · recurs every ${item.recurrenceMonths}mo`}
        </p>
      </header>

      <section aria-labelledby="record" className="flex flex-col gap-3">
        <h2 id="record" className="text-lg font-semibold">
          Record completion
        </h2>
        <RecordCompletionForm action={recordCompletion.bind(null, item.id)} />
      </section>

      <section aria-labelledby="history" className="flex flex-col gap-3">
        <h2 id="history" className="text-lg font-semibold">
          Completion history
        </h2>
        {item.completions.length === 0 ? (
          <p className="text-muted-foreground text-sm">Never recorded as done.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {item.completions.map((completion) => (
              <li key={completion.id} className="flex flex-col gap-1 px-4 py-3">
                <span className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{friendlyDate(completion.completedOn, 'UTC')}</span>
                  <span className="text-muted-foreground text-sm">
                    {completion.completedBy ? `Recorded by ${completion.completedBy.name}` : 'Recorded by the system'}
                  </span>
                </span>
                {completion.document && (
                  <a
                    href={`/api/documents/${completion.document.id}/file`}
                    className="text-sm underline underline-offset-4"
                  >
                    {completion.document.fileName}
                  </a>
                )}
                {completion.notes && <span className="text-muted-foreground text-sm">{completion.notes}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
