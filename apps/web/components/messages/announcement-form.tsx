'use client'

import { BanIcon } from 'lucide-react'
import { useActionState, useState } from 'react'
import { LiveRegion, pendingButtonProps } from '@/components/auth-form.tsx'
import { FieldError, TextField } from '@/components/form/field.tsx'
import type {
  AnnouncementFormState,
  AnnouncementRecipientResult,
  AudienceFormState,
} from '@/lib/comms/announcement-actions.ts'
import type { AnnouncementPreview } from '@/lib/comms/announcement-preview.ts'
import type { ReviewRecipient } from '@/lib/comms/announcements.ts'
import { INPUT_CLASSES, PRIMARY_BUTTON_CLASSES, scrollableRegionProps } from '@/components/ui-classes.ts'

// The composer for segment announcements (COMM-04, R-053), second step.
//
// The segment is chosen on the page by a plain GET form (one `<select>`, the
// count in every option - R-115), and this form receives who it reached as a
// REVIEWED LIST (R-259, PRD 08 A3): one checkbox per tenancy, all ticked, so
// the sender removes people rather than enumerating them. Every checkbox is
// server-rendered and ticked, so the send works before hydration; the live
// count is the only thing that needs JavaScript, and its first value is the
// right one without it.

function plural(n: number): string {
  return `${n} ${n === 1 ? 'tenant' : 'tenants'}`
}

export function AnnouncementForm({
  segment,
  templateId,
  recipients,
  sendAction,
}: {
  /// What the page's picker chose, posted back and re-resolved by the action.
  segment: string
  /// The template the page's picker chose, previewed above and posted back.
  templateId: string
  recipients: ReviewRecipient[]
  sendAction: (
    previous: AnnouncementFormState,
    formData: FormData,
  ) => Promise<AnnouncementFormState>
}) {
  const [state, action, pending] = useActionState<AnnouncementFormState, FormData>(
    sendAction,
    {},
  )
  const [ticked, setTicked] = useState(recipients.length)
  const [sendAt, setSendAt] = useState('')
  const textsOff = recipients.filter((r) => r.textsOff).length

  return (
    <form
      action={action}
      onChange={(event) =>
        setTicked(event.currentTarget.querySelectorAll('input[name="leaseIds"]:checked').length)
      }
      className="flex flex-col gap-6"
    >
      <input type="hidden" name="segment" value={segment} />

      <fieldset className="flex min-w-0 flex-col gap-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">Who gets this?</legend>
        <p className="text-muted-foreground text-sm">
          Everyone this segment reaches is ticked. Untick anyone who should not
          get it.
        </p>
        <ul className="flex flex-col">
          {recipients.map((r) => (
            <li key={r.leaseId} className="border-b last:border-0">
              <label className="flex min-h-14 min-w-0 cursor-pointer items-center gap-3 py-1.5">
                <input
                  type="checkbox"
                  name="leaseIds"
                  value={r.leaseId}
                  defaultChecked
                  className="accent-primary size-5 shrink-0"
                />
                <span className="flex min-w-0 flex-1 flex-col break-words">
                  <span className="text-sm font-medium">{r.tenantName}</span>
                  <span className="text-muted-foreground text-sm">{r.place}</span>
                </span>
                {r.textsOff && (
                  <span className="bg-warning/10 text-warning inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium">
                    <BanIcon aria-hidden className="size-3" />
                    Texts off
                  </span>
                )}
              </label>
            </li>
          ))}
        </ul>
        <div aria-live="polite" className="flex flex-col">
          <span className="text-base font-semibold">{plural(ticked)} will receive this</span>
          {textsOff > 0 && (
            <span className="text-muted-foreground text-sm">
              {textsOff} opted out of texts and will get email only.
            </span>
          )}
        </div>
      </fieldset>

      <input type="hidden" name="templateId" value={templateId} />

      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <TextField
          label="Send at"
          name="sendAt"
          type="datetime-local"
          hint="Each property's local time. Leave empty to send now. A time inside quiet hours goes out when they end."
          onChange={setSendAt}
        />
        <FieldError id="announcement-error" message={state.error} />
        <LiveRegion>
          {state.notice && <p className="text-sm">{state.notice}</p>}
        </LiveRegion>

        <button
          type="submit"
          // Disabled buttons say why in their label (Messaging P0 design).
          disabled={ticked === 0}
          {...pendingButtonProps(pending)}
          className={`${PRIMARY_BUTTON_CLASSES} self-start`}
        >
          {ticked === 0
            ? 'Tick someone to send'
            : sendAt
              ? `Schedule for ${plural(ticked)}`
              : `Send to ${plural(ticked)}`}
        </button>
      </div>

      {state.results && state.results.length > 0 && <ResultsTable results={state.results} />}
    </form>
  )
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

/// What the send will do, before it does it (R-260, PRD 08 A1/A6). Rendered
/// from the first recipient through the send's own path. Server-rendered, so
/// it is there before hydration; it counts the whole segment, and the send
/// re-checks whoever is ticked.
export function AnnouncementPreviewPanel({
  preview,
}: {
  preview: AnnouncementPreview
}) {
  return (
    <section aria-labelledby="preview-heading" className="flex flex-col gap-3 rounded-lg border p-4">
      <h2 id="preview-heading" className="text-sm font-medium">
        Preview
      </h2>
      {preview.sample && (
        <div className="bg-muted/50 flex min-w-0 flex-col gap-1 rounded-md p-3 text-sm break-words">
          <span className="text-muted-foreground text-xs">As {preview.sample.tenantName} sees it</span>
          {preview.sample.subject && <span className="font-medium">{preview.sample.subject}</span>}
          <span className="whitespace-pre-wrap">{preview.sample.body}</span>
        </div>
      )}
      <p className="text-sm">
        {preview.smsRecipients === 0
          ? 'No texts will go; everyone reached gets email only.'
          : `${preview.smsRecipients} ${preview.smsRecipients === 1 ? 'text' : 'texts'}, up to ${preview.maxSegments} ${preview.maxSegments === 1 ? 'segment' : 'segments'} each (${preview.encoding}), about ${money(preview.estimatedCostCents)}.`}
      </p>
      {preview.encoding === 'UCS-2' && (
        <p className="text-muted-foreground text-sm">
          A character outside the basic SMS set (a curly quote or emoji) makes every text
          shorter and so costlier. Swap it for a plain one to cut segments.
        </p>
      )}
      {preview.quietHeld > 0 && preview.quietUntil && (
        <p className="bg-warning/10 text-warning rounded-md p-3 text-sm">
          {preview.quietHeld} {preview.quietHeld === 1 ? 'text is' : 'texts are'} held by quiet
          hours until {preview.quietUntil}. Email is not held.
        </p>
      )}
      {preview.problems.length > 0 && (
        <div className="border-destructive text-destructive rounded-md border p-3 text-sm">
          <p className="font-medium">This cannot be sent yet:</p>
          <ul className="list-disc pl-5">
            {preview.problems.slice(0, 5).map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/// Save the segment under review as a named audience (R-259, PRD 08 A4).
export function SaveAudienceForm({
  segment,
  saveAction,
}: {
  segment: string
  saveAction: (previous: AudienceFormState, formData: FormData) => Promise<AudienceFormState>
}) {
  const [state, action, pending] = useActionState<AudienceFormState, FormData>(saveAction, {})
  return (
    <form action={action} className="flex flex-col gap-1.5">
      <input type="hidden" name="segment" value={segment} />
      <label htmlFor="audience-name" className="text-sm font-medium">
        Save this filter as an audience
      </label>
      <div className="flex min-w-0 flex-wrap gap-2">
        <input
          id="audience-name"
          name="name"
          required
          maxLength={80}
          placeholder="e.g. Oak St duplexes"
          aria-describedby="audience-error"
          className={`${INPUT_CLASSES} flex-1`}
        />
        <button type="submit" {...pendingButtonProps(pending)} className={PRIMARY_BUTTON_CLASSES}>
          Save audience
        </button>
      </div>
      <p className="text-muted-foreground text-sm">
        Saves the filter, not the ticks: it reaches whoever matches when you next send.
      </p>
      <FieldError id="audience-error" message={state.error} />
      <LiveRegion>{state.notice && <p className="text-sm">{state.notice}</p>}</LiveRegion>
    </form>
  )
}

function ResultsTable({ results }: { results: AnnouncementRecipientResult[] }) {
  return (
    <div className="overflow-x-auto" {...scrollableRegionProps('Per-recipient delivery status, scrolls sideways')}>
      <table className="w-full text-sm">
        <caption className="sr-only">Per-recipient delivery status for this send.</caption>
        <thead>
          <tr className="text-muted-foreground border-b text-left text-xs">
            <th scope="col" className="py-2 pr-3 font-medium">
              Tenant
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Property
            </th>
            <th scope="col" className="py-2 font-medium">
              Delivery
            </th>
          </tr>
        </thead>
        <tbody>
          {results.map((row) => (
            <tr key={row.leaseId} className="border-b last:border-0">
              <td className="py-2 pr-3">{row.tenantName}</td>
              <td className="py-2 pr-3">{row.propertyName}</td>
              <td className="py-2">
                {row.channels.map((c) => (
                  <span key={c.channel} className="mr-3 inline-block">
                    {c.channel}: {c.status.toLowerCase()}
                    {c.reason ? ` (${c.reason})` : ''}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
