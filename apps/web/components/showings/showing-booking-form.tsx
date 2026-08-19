'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField } from '@/components/form/field.tsx'
import type { BookingFormState } from '@/lib/showings/actions.ts'

/// A fixed grid of slots rendered as a labelled select, not a calendar
/// widget - the same choice `prescreen-form.tsx`'s income-range field makes,
/// and it needs no client-side date math or a picker dependency for a grid
/// that is already computed server-side.
export function ShowingBookingForm({
  action,
  slots,
  timezone,
}: {
  action: (state: BookingFormState, formData: FormData) => Promise<BookingFormState>
  slots: string[]
  timezone: string
}) {
  const [state, formAction] = useActionState<BookingFormState, FormData>(action, {})

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  const options = slots.map((iso) => ({ value: iso, label: formatter.format(new Date(iso)) }))

  if (options.length === 0) {
    return <p className="text-muted-foreground text-sm">No times are open right now. Contact us.</p>
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormAlerts state={state} />
      <SelectField label="Pick a time" name="slot" required idPrefix="showing" options={options} />
      <SubmitButton label="Book this showing" />
    </form>
  )
}
