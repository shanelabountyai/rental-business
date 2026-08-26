import Link from 'next/link'
import { inspectionStatus, INSPECTION_STATUS_LABELS } from '@rental/core/inspections'
import { requireScope } from '@/lib/auth/guard.ts'
import { inspectionsForScope } from '@/lib/inspections/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { PRIMARY_BUTTON_CLASSES } from '@/components/ui-classes.ts'

export const metadata = { title: 'Inspections — Rental Operations' }

export default async function InspectionsPage() {
  const { actor } = await requireScope('inspection.read')
  const scope = await currentScope(actor)
  const inspections = await inspectionsForScope(scope)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Inspections</h1>
        <p className="text-muted-foreground text-sm">
          Room-by-room condition reports, from a reusable checklist.
        </p>
      </header>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/inspections/new"
          className={PRIMARY_BUTTON_CLASSES}
        >
          New inspection
        </Link>
        <Link
          href="/inspections/templates"
          className="focus-visible:ring-ring border-input hover:bg-accent flex min-h-11 items-center rounded-md border px-4 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Checklists
        </Link>
      </div>

      {inspections.length === 0 ? (
        <p className="text-muted-foreground text-sm">No inspections yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {inspections.map((inspection) => {
            const status = inspectionStatus({
              scheduledFor: inspection.scheduledFor,
              performedAt: inspection.performedAt,
              tenantSignedAt: inspection.tenantSignedAt,
              lockedAt: inspection.lockedAt,
              anyItemRecorded: inspection.items.some((item) => item.condition != null),
            })
            return (
              <li key={inspection.id} className="rounded-lg border p-3">
                <Link
                  href={`/inspections/${inspection.id}`}
                  className="focus-visible:ring-ring font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
                >
                  {inspection.property.name} — {inspection.unit.name}
                </Link>
                <p className="text-muted-foreground mt-1 text-sm">
                  {inspection.type} · {INSPECTION_STATUS_LABELS[status]}
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
