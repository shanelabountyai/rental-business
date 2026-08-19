import { notFound } from 'next/navigation'
import { businessDate } from '@rental/core/scheduling'
import { InspectionItemForm } from '@/components/inspections/inspection-item-form.tsx'
import { InspectionSignForm } from '@/components/portal/inspection-sign-form.tsx'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { signInspectionAsTenant } from '@/lib/portal/inspection-actions.ts'
import { getTenantInspection } from '@/lib/portal/inspection-queries.ts'

export const metadata = { title: 'Your inspection report' }

// A tenant's own review-and-sign (INSP-01, R-068 phase 2).
//
// NO `loading.tsx` HERE OR ABOVE. This page calls notFound() and a
// Suspense boundary above it would stream a 200 before the page ran
// (R-099).

export default async function TenantInspectionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { scope } = await requireTenantWithScope()

  const inspection = await getTenantInspection(id, scope)
  if (!inspection) notFound()

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Your inspection report</h1>
        <p>
          {inspection.property.addressLine1}
          {inspection.unit.name ? ` (${inspection.unit.name})` : ''}
        </p>
        {inspection.tenantSignedAt ? (
          <p className="rounded-md border p-4">
            {/* A server action always refreshes the page that called it -
                the same trap /sign/[token] and /portal/papers/notice each
                document their own fix for. This branch, reached on the
                very next render after signing, IS the confirmation a
                tenant who just signed actually sees. */}
            You signed this report on{' '}
            {businessDate(inspection.tenantSignedAt, inspection.property.timezone)}. It is now
            final.
          </p>
        ) : inspection.lockedAt ? (
          <p className="rounded-md border p-4">
            This report finalized on {businessDate(inspection.lockedAt, inspection.property.timezone)}{' '}
            without a signature on file - contact us if anything about it looks wrong.
          </p>
        ) : (
          <p>Review each room below, then sign at the bottom.</p>
        )}
      </div>

      <ul className="flex flex-col gap-3">
        {inspection.items.map((item) => (
          <InspectionItemForm
            key={item.id}
            itemId={item.id}
            room={item.room}
            item={item.item}
            condition={item.condition}
            notes={item.notes}
            photos={item.photos.map((photo) => ({
              id: photo.id,
              fileName: '',
              capturedAt: null,
              geotagged: false,
            }))}
            editable={false}
          />
        ))}
      </ul>

      {!inspection.tenantSignedAt && !inspection.lockedAt && (
        <InspectionSignForm action={signInspectionAsTenant.bind(null, inspection.id)} />
      )}
    </div>
  )
}
