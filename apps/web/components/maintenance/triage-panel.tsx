'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField } from '@/components/form/field.tsx'
import type { MaintenanceFormState } from '@/lib/maintenance/actions.ts'
import type { SlaState } from '@rental/core/maintenance'

const PRIORITY_OPTIONS = [
  { value: 'URGENT', label: 'Urgent' },
  { value: 'ROUTINE', label: 'Routine' },
]

const SLA_BADGES: Record<SlaState, { label: string; className: string } | null> = {
  on_track: null,
  approaching: {
    label: 'First response due soon',
    className: 'bg-amber-100 text-amber-900',
  },
  breached: {
    label: 'First response overdue',
    className: 'bg-red-100 text-red-800',
  },
  responded: null,
}

const RESOLVED_STATUS_LABELS: Record<string, string> = {
  WAITING_ON_TENANT: 'Waiting on tenant',
  CONVERTED: 'Converted to a work order',
  MERGED: 'Merged into another ticket',
  CLOSED: 'Closed',
}

export interface TriageMergeCandidate {
  id: string
  label: string
}

/**
 * The ticket-specific half of a triage Task's detail page (MAINT-02,
 * RISK-05, R-023) - priority override, merge, and the three terminal
 * resolutions, alongside the ticket's own read-only fields. Rendered next to
 * (not instead of) the generic Task claim/complete/cancel controls that
 * every other task type already gets.
 */
export function TriagePanel({
  ticketId,
  ticket,
  slaState,
  mergeCandidates,
  existingWorkOrderId,
  setPriorityAction,
  mergeAction,
  resolveAction,
  resolved,
  canWrite,
}: {
  ticketId: string
  ticket: {
    category: string
    categoryLabel: string
    description: string
    source: string
    priority: string
    status: string
    habitabilityFlag: boolean
    mergedIntoTicketId: string | null
  }
  /// A work order already created from this ticket, if any - lets the
  /// resolved view link straight to it instead of offering to create a
  /// second one for the same CONVERTED decision.
  existingWorkOrderId?: string | null
  slaState: SlaState
  mergeCandidates: readonly TriageMergeCandidate[]
  setPriorityAction: (
    state: MaintenanceFormState,
    formData: FormData,
  ) => Promise<MaintenanceFormState>
  mergeAction: (state: MaintenanceFormState, formData: FormData) => Promise<MaintenanceFormState>
  resolveAction: (resolution: 'waiting_on_tenant' | 'converted' | 'closed') => Promise<MaintenanceFormState>
  /// Already MERGED or CLOSED - no further triage action makes sense.
  resolved: boolean
  /// Holds ticket.write on this property. The action forms below are the
  /// only thing this gates - actorCan() decided it, not this component - so
  /// a read-only viewer sees the same ticket detail with no controls that
  /// would only reject when clicked (ROLE-01's "hide, don't just block").
  canWrite: boolean
}) {
  const [priorityState, priorityFormAction] = useActionState<MaintenanceFormState, FormData>(
    setPriorityAction,
    {},
  )
  const [mergeState, mergeFormAction] = useActionState<MaintenanceFormState, FormData>(
    mergeAction,
    {},
  )
  const [waitingState, waitingFormAction] = useActionState<MaintenanceFormState, FormData>(
    resolveAction.bind(null, 'waiting_on_tenant'),
    {},
  )
  const [convertState, convertFormAction] = useActionState<MaintenanceFormState, FormData>(
    resolveAction.bind(null, 'converted'),
    {},
  )
  const [closeState, closeFormAction] = useActionState<MaintenanceFormState, FormData>(
    resolveAction.bind(null, 'closed'),
    {},
  )

  const badge = SLA_BADGES[slaState]

  return (
    <div className="flex flex-col gap-6 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{ticket.categoryLabel}</span>
        <span className="text-muted-foreground text-sm">· {ticket.source}</span>
        {ticket.habitabilityFlag && (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
            Habitability
          </span>
        )}
        {badge && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
            {badge.label}
          </span>
        )}
      </div>

      <p className="whitespace-pre-wrap rounded-md border p-3 text-sm">{ticket.description}</p>

      {resolved ? (
        <p className="text-muted-foreground text-sm">
          {RESOLVED_STATUS_LABELS[ticket.status] ?? ticket.status}
          {ticket.status === 'CONVERTED' && (
            <Link
              href={
                existingWorkOrderId
                  ? `/workorders/${existingWorkOrderId}`
                  : `/workorders/new?ticketId=${ticketId}`
              }
              className="mt-1 block underline underline-offset-4"
            >
              {existingWorkOrderId ? 'View work order' : 'Create work order'}
            </Link>
          )}
        </p>
      ) : !canWrite ? (
        <p className="text-muted-foreground text-sm">Awaiting triage.</p>
      ) : (
        <div className="flex flex-col gap-6">
          <form action={priorityFormAction} className="flex max-w-xs flex-col gap-2">
            <FormAlerts state={priorityState} />
            <SelectField
              label="Priority"
              name="priority"
              idPrefix="triage"
              required
              defaultValue={
                ticket.priority === 'URGENT' || ticket.priority === 'ROUTINE'
                  ? ticket.priority
                  : undefined
              }
              options={PRIORITY_OPTIONS}
            />
            <SubmitButton label="Set priority" />
          </form>

          {mergeCandidates.length > 0 && (
            <form action={mergeFormAction} className="flex max-w-xs flex-col gap-2">
              <FormAlerts state={mergeState} />
              <SelectField
                label="Merge into"
                name="targetTicketId"
                idPrefix="triage"
                required
                options={mergeCandidates.map((c) => ({ value: c.id, label: c.label }))}
              />
              <SubmitButton label="Merge duplicate" />
            </form>
          )}

          <div className="flex flex-col gap-3 border-t pt-4">
            <form action={waitingFormAction}>
              <FormAlerts state={waitingState} />
              <SubmitButton label="Waiting on tenant" />
            </form>
            <form action={convertFormAction}>
              <FormAlerts state={convertState} />
              <SubmitButton label="Convert to work order" />
            </form>
            <form action={closeFormAction}>
              <FormAlerts state={closeState} />
              <SubmitButton label="Close - no action needed" />
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
