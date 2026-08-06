import { CATEGORY_LABELS } from '@rental/core/maintenance'
import { activeWarranties, likelyMatchingWarranty } from '@rental/core/workorders'
import { notFound } from 'next/navigation'
import { CreateWorkOrderForm } from '@/components/workorders/create-work-order-form.tsx'
import { actorCan, requireScope } from '@/lib/auth/guard.ts'
import { getStaffTicket } from '@/lib/maintenance/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { createWorkOrder } from '@/lib/workorders/actions.ts'
import { unitsInScope, warrantiesForProperty } from '@/lib/workorders/queries.ts'

export const metadata = { title: 'New work order — Rental Operations' }

// requireScope, not a bare requirePermission: "may this actor create a work
// order ANYWHERE" (same shape as /tasks/new, /maintenance/new). The
// specific property/unit is re-checked by createWorkOrder() itself.
export default async function NewWorkOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ ticketId?: string }>
}) {
  const { ticketId } = await searchParams
  const { actor } = await requireScope('workorder.write')
  const scope = await currentScope(actor)

  // workorder.write does not imply ticket.read - every role today happens
  // to grant both together, but this page has no reason to lean on that
  // (same "hide, don't just block" call /tasks/[id] already makes for the
  // ticket-triage panel).
  const canReadTicket = await actorCan('ticket.read')
  const ticket = ticketId && canReadTicket ? await getStaffTicket(ticketId, scope) : null
  if (ticketId && !ticket) notFound()

  const propertyId = ticket?.propertyId
  const warranties = propertyId
    ? activeWarranties(await warrantiesForProperty(propertyId), new Date())
    : []
  const likely = ticket
    ? likelyMatchingWarranty(ticket.category, warranties)
    : null

  const units = ticket
    ? []
    : (await unitsInScope(scope)).map((u) => ({
        id: u.id,
        label: `${u.property.name} — ${u.name}`,
      }))

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New work order</h1>
      <p className="text-muted-foreground max-w-prose text-sm">
        From a ticket, or standalone - a make-ready turn has no ticket behind
        it (MAINT-03).
      </p>
      <CreateWorkOrderForm
        action={createWorkOrder}
        ticketId={ticket?.id}
        ticketSummary={
          ticket
            ? `${CATEGORY_LABELS[ticket.category as keyof typeof CATEGORY_LABELS] ?? ticket.category} — ${ticket.unit.name} — ${ticket.description.slice(0, 80)}`
            : undefined
        }
        units={units}
        warranties={warranties.map((w) => ({
          id: w.id,
          label: `${w.category} — ${w.provider}${w.expiresOn ? ` (expires ${w.expiresOn.toISOString().slice(0, 10)})` : ''}`,
          isLikelyMatch: likely?.id === w.id,
        }))}
      />
    </div>
  )
}
