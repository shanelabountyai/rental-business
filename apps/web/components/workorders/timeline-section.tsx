'use client'

import type { TimelineEntry } from '@rental/core/workorders'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { ReplyForm } from '@/components/comms/reply-form.tsx'
import type { WorkOrderFormState } from '@/lib/workorders/actions.ts'

// The merged timeline (COMM-06, R-032): tenant thread, vendor thread and
// staff notes, one chronological view. "Reconstructing an incident from
// three separate text histories six months later for an insurance adjuster
// is the problem this solves" - the backlog's own framing, and the reason
// this renders every kind of entry in one list rather than three tabs.

const KIND_LABELS: Record<TimelineEntry['kind'], string> = {
  ticket_submitted: 'Reported',
  tenant_message: 'Tenant',
  vendor_message: 'Vendor',
  staff_message: 'Staff',
  call_log: 'Phone call',
  staff_note: 'Internal note',
}

type Action = (
  previous: WorkOrderFormState,
  formData: FormData,
) => Promise<WorkOrderFormState>

export interface UnattachedMessage {
  id: string
  body: string
  sentAt: string
}

export function TimelineSection({
  workOrderId,
  entries,
  canWrite,
  tenantChannels,
  hasVendor,
  unattached,
  addNote,
  replyToTenant,
  replyToVendor,
  attachMessage,
}: {
  workOrderId: string
  entries: readonly (TimelineEntry & { atLocal: string })[]
  canWrite: boolean
  /// Empty when there is no tenant on this job - hides the reply form
  /// rather than showing one with nothing to send to.
  tenantChannels: readonly string[]
  hasVendor: boolean
  unattached: readonly UnattachedMessage[]
  addNote: Action
  replyToTenant: Action
  replyToVendor: Action
  attachMessage: Action
}) {
  return (
    <section aria-labelledby="timeline" className="flex flex-col gap-4 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="timeline" className="text-lg font-semibold">
          Timeline
        </h2>
        <a
          href={`/workorders/${workOrderId}/timeline`}
          className="text-muted-foreground hover:text-foreground min-h-11 text-sm underline underline-offset-4"
        >
          Download as text
        </a>
      </div>

      {entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing recorded yet.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {entries.map((entry, index) => (
            <li
              // Entries have no id of their own - they are assembled from
              // three different tables - so position is the only stable key
              // once the list is chronologically sorted server-side.
              key={index}
              className={`flex flex-col gap-1 rounded-md border p-3 text-sm ${
                entry.kind === 'staff_note' ? 'border-dashed' : ''
              }`}
            >
              <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
                <span>
                  {KIND_LABELS[entry.kind]} · {entry.author}
                  {entry.channel ? ` (${entry.channel})` : ''}
                </span>
                <span>{entry.atLocal}</span>
              </div>
              <p className="whitespace-pre-wrap">{entry.body}</p>
            </li>
          ))}
        </ol>
      )}

      {canWrite && unattached.length > 0 && (
        <AttachSection unattached={unattached} attachMessage={attachMessage} />
      )}

      {canWrite && (
        <div className="flex flex-col gap-6">
          {tenantChannels.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-sm font-medium">Message the tenant</h3>
              <ReplyForm action={replyToTenant} channels={tenantChannels} />
            </div>
          )}
          {hasVendor && (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-sm font-medium">Message the vendor</h3>
              <VendorReplyForm action={replyToVendor} />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium">Add an internal note</h3>
            <p className="text-muted-foreground text-xs">
              Never sent to the tenant or vendor - visible to staff only.
            </p>
            <NoteForm action={addNote} />
          </div>
        </div>
      )}
    </section>
  )
}

function VendorReplyForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState<WorkOrderFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FormAlerts state={state} />
      <label htmlFor="field-vendor-reply-body" className="sr-only">
        Message the vendor
      </label>
      <textarea
        id="field-vendor-reply-body"
        name="body"
        rows={3}
        required
        aria-invalid={Boolean(errors.body) || undefined}
        className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none aria-invalid:border-red-500"
      />
      <SubmitButton label="Send" />
    </form>
  )
}

function NoteForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState<WorkOrderFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FormAlerts state={state} />
      <label htmlFor="field-work-order-note-body" className="sr-only">
        Add an internal note
      </label>
      <textarea
        id="field-work-order-note-body"
        name="body"
        rows={3}
        required
        aria-invalid={Boolean(errors.body) || undefined}
        className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none aria-invalid:border-red-500"
      />
      <SubmitButton label="Add note" />
    </form>
  )
}

/**
 * "Might this be about this job?" (COMM-06). The tenant's recent
 * conversation, filtered to what nobody has tagged to any job yet - a
 * per-row Attach button is the human judgement call that closes the gap
 * inbound texts leave (see `unattachedTenantMessages`'s own comment).
 */
function AttachSection({
  unattached,
  attachMessage,
}: {
  unattached: readonly UnattachedMessage[]
  attachMessage: Action
}) {
  // ONE action-state shared across every row, same as the emergency
  // response panel's per-vendor buttons - only one row is ever being
  // submitted at a time, and a hidden `messageId` input is what tells the
  // shared action which row that was.
  const [state, formAction] = useActionState<WorkOrderFormState, FormData>(
    attachMessage,
    {},
  )
  return (
    <details className="rounded-md border p-3">
      <summary className="min-h-11 cursor-pointer text-sm font-medium">
        Recent messages that might belong here ({unattached.length})
      </summary>
      <FormAlerts state={state} />
      <ul className="mt-2 flex flex-col gap-2">
        {unattached.map((message) => (
          <li
            key={message.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
          >
            <span className="flex flex-col">
              <span className="whitespace-pre-wrap">{message.body}</span>
              <span className="text-muted-foreground text-xs">{message.sentAt}</span>
            </span>
            <form action={formAction}>
              <input type="hidden" name="messageId" value={message.id} />
              <button
                type="submit"
                className="focus-visible:ring-ring border-input min-h-11 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                Attach
              </button>
            </form>
          </li>
        ))}
      </ul>
    </details>
  )
}
