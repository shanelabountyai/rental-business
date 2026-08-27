'use client'

import { useActionState } from 'react'
import { LiveRegion, pendingButtonProps } from '@/components/auth-form.tsx'
import { FieldError, SelectField } from '@/components/form/field.tsx'
import type {
  AnnouncementFormState,
  AnnouncementRecipientResult,
} from '@/lib/comms/announcement-actions.ts'
import type { SegmentOptions } from '@/lib/comms/announcements.ts'
import { PRIMARY_BUTTON_CLASSES, scrollableRegionProps } from '@/components/ui-classes.ts'

// The composer for segment announcements (COMM-04, R-053).
//
// ==========================================================================
// ONE SELECT, WITH THE BLAST RADIUS IN EVERY OPTION (R-115).
//
// It was two controls: a segment TYPE dropdown held in `useState`, and a
// value dropdown that rendered only when that state said so. Two consequences
// the audit found together. Before hydration the second control did not
// exist, so the only segment reachable on a first paint was the default -
// "All tenants", the widest one. And nothing anywhere said how many people
// any of it reached; the per-recipient results table renders only after the
// send.
//
// Collapsing the pair into one `<select>` of `TYPE:value` options answers
// both, and deletes the state, the conditional, and the two "nothing in
// scope" empty states with it - an optgroup with no options simply does not
// render. `segmentOptions` puts the count in each label, so the number is in
// front of the person BEFORE they choose rather than after they have sent.
//
// The value/template pickers use `SelectField` (`components/form/field.tsx`)
// rather than a hand-rolled `<label>` wrapping a `<select>`, and that is not
// cosmetic: a label that WRAPS its control gets an accessible name built from
// the control's own rendered content, so a select whose options include the
// word "property" collided with the global property/entity switcher's
// "Property" label under `getByLabel` - caught by this form's own e2e spec.
// `SelectField` keeps the label a SIBLING, associated by `htmlFor`/`id`,
// whose accessible name is its own text and nothing the control renders.
// ==========================================================================

function withCount(choice: { label: string; count: number }): string {
  return `${choice.label} — ${choice.count} ${choice.count === 1 ? 'tenant' : 'tenants'}`
}

export function AnnouncementForm({
  options,
  templates,
  sendAction,
}: {
  options: SegmentOptions
  templates: { id: string; name: string }[]
  sendAction: (
    previous: AnnouncementFormState,
    formData: FormData,
  ) => Promise<AnnouncementFormState>
}) {
  const [state, action, pending] = useActionState<AnnouncementFormState, FormData>(
    sendAction,
    {},
  )

  const groups = [
    { label: 'One property', choices: options.properties },
    { label: 'One metro', choices: options.metros },
    { label: 'One tag', choices: options.tags },
  ].filter((group) => group.choices.length > 0)

  return (
    <form action={action} className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <h2 className="text-sm font-medium">Send an announcement</h2>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="segment" className="text-sm font-medium">
            Send to
          </label>
          <select
            id="segment"
            name="segment"
            defaultValue="ALL"
            aria-describedby="segment-hint"
            className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            <option value={options.all.value}>{withCount(options.all)}</option>
            {groups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {withCount(choice)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <p id="segment-hint" className="text-muted-foreground text-sm">
            Counts are current tenancies. A lease on a marketing hold, or a
            tenant whose merge fields cannot be filled, is dropped at send time
            and named in the results below.
          </p>
        </div>

        <SelectField
          label="Template"
          name="templateId"
          required
          placeholder="Choose a template…"
          options={templates.map((template) => ({ value: template.id, label: template.name }))}
        />

        {templates.length === 0 && (
          <p className="text-muted-foreground text-sm">
            There are no templates yet. Write one first.
          </p>
        )}

        <FieldError id="announcement-error" message={state.error} />
        <LiveRegion>
          {state.notice && <p className="text-sm">{state.notice}</p>}
        </LiveRegion>

        <button
          type="submit"
          disabled={templates.length === 0}
          {...pendingButtonProps(pending)}
          className={`${PRIMARY_BUTTON_CLASSES} self-start`}
        >
          Send
        </button>
      </div>

      {state.results && state.results.length > 0 && <ResultsTable results={state.results} />}
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
