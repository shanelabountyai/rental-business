'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField, TextField } from '@/components/form/field.tsx'
import type { InspectionFormState } from '@/lib/inspections/actions.ts'

const CONDITION_OPTIONS = [
  { value: 'NEW', label: 'New' },
  { value: 'GOOD', label: 'Good' },
  { value: 'FAIR', label: 'Fair' },
  { value: 'POOR', label: 'Poor' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'MISSING', label: 'Missing' },
]

export interface ItemPhoto {
  id: string
  fileName: string
  capturedAt: string | null
  geotagged: boolean
}

export function InspectionItemForm({
  action,
  photoAction,
  itemId,
  room,
  item,
  condition,
  notes,
  photos,
  editable,
}: {
  /// Omitted on the tenant's own read-only review, which never renders a
  /// form at all (the `!editable` branch below returns before either
  /// action is ever used) - `useActionState` still needs to be called
  /// unconditionally either way (React's own rule on hooks), hence the
  /// no-op fallback rather than making the caller pass a throwaway one.
  action?: (
    state: InspectionFormState,
    formData: FormData,
  ) => Promise<InspectionFormState>
  /// Omitted on the tenant's own read-only review - a tenant sees the
  /// photos staff already took, never adds their own.
  photoAction?: (
    state: InspectionFormState,
    formData: FormData,
  ) => Promise<InspectionFormState>
  itemId: string
  room: string
  item: string
  condition: string | null
  notes: string | null
  photos: readonly ItemPhoto[]
  editable: boolean
}) {
  const [state, formAction] = useActionState<InspectionFormState, FormData>(
    action ?? (async (previous) => previous),
    {},
  )

  const photoGallery = photos.length > 0 && (
    <ul className="mt-2 flex flex-wrap gap-2">
      {photos.map((photo) => (
        <li key={photo.id}>
          <a href={`/api/documents/${photo.id}/file`} target="_blank" rel="noopener noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element -- an
                inline thumbnail of an uploaded photo, not an optimizable
                static asset next/image is built for. */}
            <img
              src={`/api/documents/${photo.id}/file`}
              alt={`${room} — ${item}${photo.geotagged ? ', geotagged' : ''}`}
              className="h-20 w-20 rounded-md border object-cover"
            />
          </a>
        </li>
      ))}
    </ul>
  )

  if (!editable) {
    return (
      <li className="rounded-lg border p-3">
        <p className="font-medium">
          {room} — {item}
        </p>
        <p className="text-muted-foreground text-sm">
          {condition ? CONDITION_OPTIONS.find((c) => c.value === condition)?.label : 'Not recorded'}
          {notes && ` · ${notes}`}
        </p>
        {photoGallery}
      </li>
    )
  }

  return (
    <li className="rounded-lg border p-3">
      <p className="font-medium">
        {room} — {item}
      </p>
      <form action={formAction} className="mt-2 flex flex-col gap-2">
        <FormAlerts state={state} />
        <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
          <SelectField
            label="Condition"
            name="condition"
            required
            idPrefix={`item-${itemId}`}
            defaultValue={condition ?? undefined}
            error={state.fieldErrors?.condition}
            options={CONDITION_OPTIONS}
          />
          <TextField
            label="Notes"
            name="notes"
            idPrefix={`item-${itemId}`}
            defaultValue={notes ?? ''}
            error={state.fieldErrors?.notes}
          />
          <SubmitButton label="Save" />
        </div>
      </form>
      {photoGallery}
      {photoAction && <PhotoUploadForm action={photoAction} itemId={itemId} />}
    </li>
  )
}

function PhotoUploadForm({
  action,
  itemId,
}: {
  action: (
    state: InspectionFormState,
    formData: FormData,
  ) => Promise<InspectionFormState>
  itemId: string
}) {
  const [state, formAction] = useActionState<InspectionFormState, FormData>(action, {})
  const id = `item-${itemId}-photo`
  return (
    <form action={formAction} className="mt-2 flex flex-wrap items-end gap-2">
      <FormAlerts state={state} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          Add a photo
        </label>
        <input id={id} type="file" name="file" accept="image/*" className="text-sm" />
      </div>
      <SubmitButton label="Upload" />
    </form>
  )
}
