import { complianceItemTypeLabel } from '@rental/core/compliance'
import { friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
import { listComplianceItems } from '@/lib/compliance/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Compliance calendar — Rental Operations' }

// The compliance calendar (PROP-05, R-077): every licensed, certified or
// filed obligation with a due date, property- or entity-scoped, soonest
// first. "When was this last done, in one lookup" is each row's own
// completion date; the full history lives on the item's own page.
export default async function CompliancePage() {
  const { actor } = await requireScope('property.read')
  const scope = await currentScope(actor)
  const items = await listComplianceItems(scope)
  const today = new Date().toISOString().slice(0, 10)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Compliance calendar</h1>
        <Link
          href="/compliance/new"
          className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Add item
        </Link>
      </div>

      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing on the calendar yet.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {items.map((item) => {
            const dueOn = item.dueOn.toISOString().slice(0, 10)
            const overdue = dueOn < today
            const lastCompleted = item.completions[0]?.completedOn ?? null
            return (
              <li key={item.id}>
                <Link
                  href={`/compliance/${item.id}`}
                  className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
                >
                  <span className="font-medium">
                    {item.label}
                    {overdue && (
                      <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                        Overdue
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground text-sm">
                    {complianceItemTypeLabel(item.type)} · {item.property?.name ?? item.legalEntity?.name} ·{' '}
                    due {friendlyBusinessDate(utcToBusinessDate(item.dueOn))}
                    {lastCompleted && <> · last done {friendlyBusinessDate(utcToBusinessDate(lastCompleted))}</>}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
