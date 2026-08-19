import Link from 'next/link'
import { notFound } from 'next/navigation'
import { canEditItem, inspectionStatus, INSPECTION_STATUS_LABELS } from '@rental/core/inspections'
import { businessDate } from '@rental/core/scheduling'
import { InspectionItemForm } from '@/components/inspections/inspection-item-form.tsx'
import { TaskActionButton } from '@/components/tasks/action-button.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import {
  finishInspection,
  lockInspection,
  recordItem,
  recordSignature,
} from '@/lib/inspections/actions.ts'
import { getInspection } from '@/lib/inspections/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Inspection — Rental Operations' }

// NO `loading.tsx` HERE OR ABOVE. This page calls notFound() and a Suspense
// boundary above it would stream a 200 before the page ran (R-099).

export default async function InspectionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { actor } = await requireScope('inspection.read')
  const scope = await currentScope(actor)

  const inspection = await getInspection(id, scope)
  if (!inspection) notFound()

  const status = inspectionStatus({
    scheduledFor: inspection.scheduledFor,
    performedAt: inspection.performedAt,
    tenantSignedAt: inspection.tenantSignedAt,
    lockedAt: inspection.lockedAt,
    anyItemRecorded: inspection.items.some((item) => item.condition != null),
  })
  const editable = canEditItem({ lockedAt: inspection.lockedAt }).allowed
  const canFinish = inspection.items.length > 0 && inspection.items.every((item) => item.condition != null)

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/inspections"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Inspections
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {inspection.property.name} — {inspection.unit.name}
        </h1>
        <p className="text-muted-foreground text-sm">
          {inspection.type} · {INSPECTION_STATUS_LABELS[status]}
          {inspection.template && ` · ${inspection.template.name}`}
        </p>
        {inspection.performedAt && (
          <p className="text-muted-foreground text-sm">
            Performed {businessDate(inspection.performedAt, inspection.property.timezone)}
            {inspection.performedBy && ` by ${inspection.performedBy.name}`}
          </p>
        )}
        {inspection.tenantSignedAt && (
          <p className="text-muted-foreground text-sm">
            Signed {businessDate(inspection.tenantSignedAt, inspection.property.timezone)}
          </p>
        )}
        {inspection.lockedAt && (
          <p className="text-sm font-medium">
            Locked {businessDate(inspection.lockedAt, inspection.property.timezone)} — this report
            cannot be edited.
          </p>
        )}
      </header>

      <ul className="flex flex-col gap-3">
        {inspection.items.map((item) => (
          <InspectionItemForm
            key={item.id}
            action={recordItem.bind(null, item.id)}
            itemId={item.id}
            room={item.room}
            item={item.item}
            condition={item.condition}
            notes={item.notes}
            editable={editable}
          />
        ))}
      </ul>

      {editable && (
        <section className="flex flex-col gap-3 border-t pt-4">
          {!inspection.performedAt && (
            <div className="flex flex-col gap-1">
              {!canFinish && (
                <p className="text-muted-foreground text-sm">
                  Every item needs a condition before the walk can be finished.
                </p>
              )}
              <TaskActionButton
                action={finishInspection.bind(null, inspection.id)}
                label="Finish walk"
              />
            </div>
          )}
          {inspection.performedAt && !inspection.tenantSignedAt && (
            <TaskActionButton
              action={recordSignature.bind(null, inspection.id)}
              label="Record tenant signature"
            />
          )}
          {inspection.performedAt && (
            <TaskActionButton action={lockInspection.bind(null, inspection.id)} label="Lock report" />
          )}
        </section>
      )}
    </div>
  )
}
