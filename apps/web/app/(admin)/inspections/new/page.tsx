import Link from 'next/link'
import { StartInspectionForm } from '@/components/inspections/start-inspection-form.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import { startInspection } from '@/lib/inspections/actions.ts'
import { unitsForNewInspection } from '@/lib/inspections/queries.ts'
import { listInspectionTemplates } from '@/lib/inspections/template-queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'New inspection — Rental Operations' }

export default async function NewInspectionPage() {
  const { actor } = await requireScope('inspection.write')
  const scope = await currentScope(actor)
  const [units, templates] = await Promise.all([
    unitsForNewInspection(scope),
    listInspectionTemplates(),
  ])
  const activeTemplates = templates.filter((template) => template.active)

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/inspections"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Inspections
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New inspection</h1>
      </header>

      {units.length === 0 ? (
        <p className="text-muted-foreground text-sm">There are no units in scope.</p>
      ) : activeTemplates.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No checklists yet.{' '}
          <Link href="/inspections/templates/new" className="underline underline-offset-2">
            Build one first
          </Link>
          .
        </p>
      ) : (
        <StartInspectionForm
          action={startInspection}
          units={units.map((unit) => ({ id: unit.id, label: `${unit.property.name} — ${unit.name}` }))}
          templates={activeTemplates.map((template) => ({ id: template.id, label: template.name }))}
        />
      )}
    </div>
  )
}
