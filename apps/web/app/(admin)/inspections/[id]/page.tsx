import Link from 'next/link'
import { notFound } from 'next/navigation'
import { earliestCompliantStart } from '@rental/core/entry'
import {
  canEditItem,
  inspectionRequiresEntryNotice,
  inspectionStatus,
  INSPECTION_STATUS_LABELS,
} from '@rental/core/inspections'
import { businessDate, friendlyTimestamp, utcToWallClock } from '@rental/core/scheduling'
import { FinishWalkForm } from '@/components/inspections/finish-walk-form.tsx'
import { InspectionItemForm } from '@/components/inspections/inspection-item-form.tsx'
import { TaskActionButton } from '@/components/tasks/action-button.tsx'
import { ScheduleForm } from '@/components/workorders/schedule-form.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import {
  finishInspection,
  lockInspection,
  recordItem,
  recordItemPhoto,
  recordSignature,
} from '@/lib/inspections/actions.ts'
import { scheduleInspectionEntry } from '@/lib/inspections/scheduling.ts'
import { getInspection } from '@/lib/inspections/queries.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
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

  // The entry-notice chain (R-157): an interior walk of an occupied unit is
  // somebody entering a tenant's home, and goes through the same
  // entryDecision → generate → serve → log chain work orders use. Tolerated
  // as null when no rule is configured for the state, so an unconfigured
  // jurisdiction shows the form rather than 500ing the page.
  const entryRequired = inspectionRequiresEntryNotice(inspection.type, inspection.lease?.status ?? null)
  const entryRule = entryRequired
    ? await rulesFor(
        { state: inspection.property.state, county: inspection.property.county },
        new Date(),
      ).catch(() => null)
    : null
  const zone = inspection.property.timezone
  const localInput = (value: Date | null) => (value ? utcToWallClock(value, zone) : null)

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
            photoAction={recordItemPhoto.bind(null, item.id)}
            itemId={item.id}
            room={item.room}
            item={item.item}
            condition={item.condition}
            notes={item.notes}
            photos={item.photos.map((photo) => ({
              id: photo.id,
              fileName: photo.fileName,
              capturedAt: photo.capturedAt?.toISOString() ?? null,
              geotagged: photo.latitude != null && photo.longitude != null,
            }))}
            editable={editable}
            moveIn={
              item.moveInItem && {
                condition: item.moveInItem.condition,
                notes: item.moveInItem.notes,
                photos: item.moveInItem.photos.map((photo) => ({
                  id: photo.id,
                  fileName: photo.fileName,
                  capturedAt: photo.capturedAt?.toISOString() ?? null,
                  geotagged: photo.latitude != null && photo.longitude != null,
                })),
              }
            }
          />
        ))}
      </ul>

      {editable && (
        <section className="flex flex-col gap-3 border-t pt-4">
          {entryRequired && !inspection.performedAt && (
            <div className="flex flex-col gap-2">
              {inspection.entryNoticeId ? (
                <p className="text-sm">
                  Entry notice served
                  {inspection.scheduledFor &&
                    ` for the window starting ${friendlyTimestamp(inspection.scheduledFor, zone)}`}
                  .
                </p>
              ) : inspection.entryOverriddenAt ? (
                <p className="text-sm">
                  Scheduled on a logged override — the reason is on the record.
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">
                  This unit is occupied — schedule the visit so the entry notice is served before
                  anyone goes in.
                </p>
              )}
              <ScheduleForm
                action={scheduleInspectionEntry.bind(null, inspection.id)}
                entryNoticeHours={entryRule?.entryNoticeHours ?? null}
                earliestCompliant={
                  entryRule?.entryNoticeHours != null
                    ? friendlyTimestamp(
                        earliestCompliantStart(new Date(), entryRule.entryNoticeHours),
                        zone,
                      )
                    : null
                }
                scheduledStart={localInput(inspection.scheduledFor)}
                scheduledEnd={localInput(inspection.scheduledEndAt)}
                hasPermission={false}
                isEmergency={false}
              />
            </div>
          )}
          {!inspection.performedAt && (
            <div className="flex flex-col gap-1">
              {!canFinish && (
                <p className="text-muted-foreground text-sm">
                  Every item needs a condition before the walk can be finished.
                </p>
              )}
              <FinishWalkForm action={finishInspection.bind(null, inspection.id)} />
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
