import { workOrderTimelineText } from '@rental/core/workorders'
import { requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { getWorkOrder } from '@/lib/workorders/queries.ts'
import { workOrderTimeline } from '@/lib/workorders/timeline.ts'

// The single exportable timeline, downloadable (COMM-06, R-032).
//
// PLAIN TEXT, not a PDF. R-052 (COMM-05) owns the timestamped PDF transcript
// with delivery metadata and letterhead - "the packet you hand an
// attorney, an adjuster or a judge." Building that here would duplicate an
// already-scoped later item; this is the raw record itself, useful today
// and a strict subset of what R-052 will eventually render.

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { actor } = await requireScope('workorder.read')
  const scope = await currentScope(actor)

  // `getWorkOrder`'s own scope filter IS the authorization here - same as
  // the work order detail page's own guard - so a work order outside this
  // actor's scope returns null and is treated exactly like one that does
  // not exist.
  const workOrder = await getWorkOrder(id, scope)
  if (!workOrder) {
    return new Response('Not found', { status: 404 })
  }

  const entries = await workOrderTimeline(id)
  const text = workOrderTimelineText(
    {
      propertyName: workOrder.property.name,
      addressLine1: workOrder.property.addressLine1,
      unitName: workOrder.unit.name,
      scope: workOrder.scope,
      workOrderStatus: workOrder.status,
      timezone: workOrder.property.timezone,
    },
    entries,
  )

  return new Response(text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="work-order-${id}-timeline.txt"`,
    },
  })
}
