import Link from 'next/link'
import { RunBatchButton } from '@/components/maintenance/run-batch-button.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { runPreventiveBatch } from '@/lib/maintenance/preventive-actions.ts'
import { dueCountForTemplate, listPreventiveTemplates } from '@/lib/maintenance/preventive-queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Preventive maintenance — Rental Operations' }

// "As a PM, I can run recurring/preventive maintenance from schedules and
// seasonal batch templates ... one click creates the batch across
// properties, assigned by vendor territory" (MAINT-08, R-080). Each
// template's "due" count is read live off the last CLOSED work order that
// fulfilled it (`WorkOrder.pmTemplateId`) - no separate schedule-tracking
// table.
export default async function PreventiveMaintenancePage() {
  const actor = await requirePermission('workorder.write')
  const scope = await currentScope(actor)
  const templates = await listPreventiveTemplates()

  const withCounts = await Promise.all(
    templates.map(async (template) => ({
      template,
      dueCount: template.active ? await dueCountForTemplate(template.id, template, scope) : 0,
    })),
  )

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Preventive maintenance</h1>
        <Link
          href="/maintenance/preventive/new"
          className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          New template
        </Link>
      </div>

      {templates.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No recurring tasks on file yet - HVAC filters, gutters, winterization, water heater flush, and so on.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {withCounts.map(({ template, dueCount }) => (
            <li key={template.id} className="flex flex-col gap-3 px-4 py-3">
              <Link
                href={`/maintenance/preventive/${template.id}`}
                className="focus-visible:ring-ring w-fit rounded focus-visible:ring-2 focus-visible:outline-none"
              >
                <span className="font-medium">
                  {template.name}
                  {!template.active && <span className="text-muted-foreground"> (inactive)</span>}
                </span>
                <span className="text-muted-foreground block text-sm">
                  Every {template.intervalMonths} month{template.intervalMonths === 1 ? '' : 's'}
                  {template.trade ? ` · ${template.trade}` : ''} · {scope.propertyIds.length} propert
                  {scope.propertyIds.length === 1 ? 'y' : 'ies'} in scope
                </span>
              </Link>
              {template.active && <RunBatchButton action={runPreventiveBatch.bind(null, template.id)} dueCount={dueCount} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
