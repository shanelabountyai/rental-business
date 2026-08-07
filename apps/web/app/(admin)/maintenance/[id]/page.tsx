import { CATEGORY_LABELS, emergencyDefinition } from '@rental/core/maintenance'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { EmergencyResponsePanel } from '@/components/maintenance/emergency-response-panel.tsx'
import { actorCan, requirePermission } from '@/lib/auth/guard.ts'
import {
  acknowledgeEmergency,
  setVendorEmergencyAvailability,
} from '@/lib/maintenance/actions.ts'
import { emergencyVendorsForTrade } from '@/lib/maintenance/emergency.ts'
import { getStaffTicket } from '@/lib/maintenance/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Maintenance request — Rental Operations' }

const SOURCE_LABELS: Record<string, string> = {
  PORTAL: 'Portal',
  SMS: 'Text',
  EMAIL: 'Email',
  PHONE_LOGGED: 'Phone',
  STAFF: 'Staff',
}
const STATUS_LABELS: Record<string, string> = {
  NEW: 'New',
  TRIAGED: 'Triaged',
  WAITING_ON_TENANT: 'Waiting on tenant',
  CONVERTED: 'Work order created',
  MERGED: 'Merged',
  CLOSED: 'Closed',
}

/// R-023's triage queue owns priority override, work-order conversion, and
/// merge - this is a plain read view, the minimum needed to confirm a
/// logged request landed with the right fields (R-022).
export default async function StaffTicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const actor = await requirePermission('ticket.read')
  const scope = await currentScope(actor)

  const ticket = await getStaffTicket(id, scope)
  if (!ticket) notFound()

  // Only for emergencies. Acknowledgement exists to stop the escalation
  // chain, and there is no chain behind a routine ticket - putting the panel
  // on every one would teach people to ignore it.
  const trade = emergencyDefinition(ticket.category)?.trade ?? null
  const isEmergency = ticket.priority === 'EMERGENCY'
  const [vendors, canEditVendors] = isEmergency
    ? await Promise.all([emergencyVendorsForTrade(trade), actorCan('vendor.write')])
    : [[], false]

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">
          <Link href="/maintenance" className="underline underline-offset-4">
            {ticket.property.name}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {CATEGORY_LABELS[ticket.category as keyof typeof CATEGORY_LABELS] ??
            ticket.category}
          {ticket.habitabilityFlag && (
            <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 align-middle text-xs font-medium text-red-800 dark:bg-red-950 dark:text-red-200">
              Habitability
            </span>
          )}
        </h1>
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <dt className="text-muted-foreground">Status</dt>
        <dd className="col-span-1 sm:col-span-2">
          {STATUS_LABELS[ticket.status] ?? ticket.status}
        </dd>
        <dt className="text-muted-foreground">Source</dt>
        <dd className="col-span-1 sm:col-span-2">
          {SOURCE_LABELS[ticket.source] ?? ticket.source}
        </dd>
        <dt className="text-muted-foreground">Unit</dt>
        <dd className="col-span-1 sm:col-span-2">{ticket.unit.name}</dd>
        <dt className="text-muted-foreground">Tenant</dt>
        <dd className="col-span-1 sm:col-span-2">
          {ticket.tenant
            ? `${ticket.tenant.firstName} ${ticket.tenant.lastName}${ticket.tenant.phone ? ` — ${ticket.tenant.phone}` : ''}`
            : 'No tenant on file'}
        </dd>
        <dt className="text-muted-foreground">Entry permitted</dt>
        <dd className="col-span-1 sm:col-span-2">
          {ticket.entryPermission ? 'Yes' : 'No'}
        </dd>
        <dt className="text-muted-foreground">Pet at home</dt>
        <dd className="col-span-1 sm:col-span-2">{ticket.petWarning ? 'Yes' : 'No'}</dd>
      </dl>

      {isEmergency && (
        <EmergencyResponsePanel
          ticketId={ticket.id}
          acknowledged={
            ticket.acknowledgedAt
              ? {
                  at: ticket.acknowledgedAt.toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  }),
                  by: ticket.acknowledgedBy?.name ?? null,
                }
              : null
          }
          trade={trade}
          vendors={vendors}
          canEditVendors={canEditVendors}
          acknowledge={acknowledgeEmergency}
          setEmergencyAvailability={setVendorEmergencyAvailability}
        />
      )}

      <div className="flex flex-col gap-1.5">
        <h2 className="text-sm font-medium">Description</h2>
        <p className="whitespace-pre-wrap rounded-md border p-3 text-sm">
          {ticket.description}
        </p>
      </div>
    </div>
  )
}
