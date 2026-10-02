import { complianceItemTypeLabel } from '@rental/core/compliance'
import { friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
import { listComplianceItems } from '@/lib/compliance/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'
import { Badge } from '@/components/badge.tsx'

export const metadata = { title: 'Compliance calendar — Rental Operations' }

// The compliance calendar (PROP-05, R-077): every licensed, certified or
// filed obligation with a due date, property- or entity-scoped, soonest
// first. "When was this last done, in one lookup" is each row's own
// completion date; the full history lives on the item's own page.
export default async function CompliancePage() {
  const { actor } = await requireScope('property.read')
  const scope = await currentScope(actor, 'property.read')
  const items = await listComplianceItems(scope)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Compliance calendar</h1>
        <Link
          href="/compliance/new"
          className={`${SUBMIT_BUTTON_CLASSES} flex min-h-11 items-center justify-center px-4 text-sm`}
        >
          Add item
        </Link>
      </div>

      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing on the calendar yet.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {items.map((item) => {
            const lastCompleted = item.completions[0]?.completedOn ?? null
            return (
              <li key={item.id}>
                <Link
                  href={`/compliance/${item.id}`}
                  className="hover:bg-secondary focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
                >
                  <span className="font-medium">
                    {item.label}
                    {item.overdue && (
                      <span className="ml-2">
                        <Badge tone="danger">Overdue</Badge>
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
