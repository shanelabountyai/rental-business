'use client'

import { useActionState, useState } from 'react'
import { LiveRegion } from '@/components/auth-form.tsx'
import { FieldError, SelectField } from '@/components/form/field.tsx'
import type {
  AnnouncementFormState,
  AnnouncementRecipientResult,
} from '@/lib/comms/announcement-actions.ts'
import type { SegmentOptions, SegmentType } from '@/lib/comms/announcements.ts'

// The composer for segment announcements (COMM-04, R-053).
//
// One dropdown decides WHICH segment control shows, not four always-visible
// fields that could disagree about which one wins. "All tenants" needs no
// second value at all — the empty state for that case is simply not
// rendering the second control, same reasoning as the rent-roll table's "no
// control at all, not a disabled one".
//
// The value/template pickers use `SelectField` (`components/form/field.tsx`)
// rather than a hand-rolled `<label>` wrapping a `<select>`, and that is not
// cosmetic: a label that WRAPS its control gets an accessible name built from
// the control's own rendered content, so a select whose options include the
// word "property" (this page's own "One property" segment) collided with the
// global property/entity switcher's "Property" label under `getByLabel` —
// caught by this form's own e2e spec. `SelectField` keeps the label a
// SIBLING, associated by `htmlFor`/`id`, whose accessible name is its own
// text and nothing the control renders.

const SEGMENT_LABELS: Record<SegmentType, string> = {
  ALL: 'All tenants',
  PROPERTY: 'One property',
  METRO: 'One metro',
  TAG: 'One tag',
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
  const [segmentType, setSegmentType] = useState<SegmentType>('ALL')

  const valueOptions =
    segmentType === 'PROPERTY'
      ? options.properties.map((p) => ({ value: p.id, label: p.name }))
      : segmentType === 'METRO'
        ? options.metros.map((m) => ({ value: m, label: m }))
        : segmentType === 'TAG'
          ? options.tags.map((t) => ({ value: t, label: t }))
          : []

  return (
    <form action={action} className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <h2 className="text-sm font-medium">Send an announcement</h2>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="segment-type" className="text-sm font-medium">
            Send to
          </label>
          <select
            id="segment-type"
            name="segmentType"
            value={segmentType}
            onChange={(e) => setSegmentType(e.target.value as SegmentType)}
            className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            {(Object.keys(SEGMENT_LABELS) as SegmentType[]).map((type) => (
              <option key={type} value={type}>
                {SEGMENT_LABELS[type]}
              </option>
            ))}
          </select>
        </div>

        {segmentType !== 'ALL' && (
          <>
            <SelectField
              label={
                segmentType === 'PROPERTY' ? 'Property' : segmentType === 'METRO' ? 'Metro' : 'Tag'
              }
              name="segmentValue"
              required
              options={valueOptions}
            />
            {valueOptions.length === 0 && (
              <p className="text-muted-foreground text-sm">
                {segmentType === 'PROPERTY'
                  ? 'No properties in scope.'
                  : `No property has a ${segmentType === 'METRO' ? 'metro' : 'tag'} set yet — add one on the property record.`}
              </p>
            )}
          </>
        )}

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
          disabled={pending || templates.length === 0}
          className="bg-foreground text-background min-h-11 self-start rounded-md px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
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
    <div className="overflow-x-auto">
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
