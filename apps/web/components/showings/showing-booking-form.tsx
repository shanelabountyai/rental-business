'use client'

import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { SelectField } from '@/components/form/field.tsx'
import type { BookingFormState } from '@/lib/showings/actions.ts'

/// A fixed grid of slots rendered as labelled selects, not a calendar widget
/// - the same choice `prescreen-form.tsx`'s income-range field makes, and it
/// needs no client-side date math or a picker dependency for a grid that is
/// already computed server-side.
///
/// TWO SELECTS, NOT ONE (R-141). `availableShowingSlots` offers every
/// half-hour from 9 to 6 for fourteen days, so the single "Pick a time" field
/// this used to be held **233 options** in one list - a wheel picker on a
/// phone that somebody scrolls a hundred entries into to reach next Tuesday.
/// Splitting on the property-local day gives 14 and then at most 18, which is
/// the shape every booking product settles on for the same reason.
///
/// The DAY field carries no slot value: `name="slot"` stays on the time
/// field, so the server action is untouched and still re-validates the exact
/// instant it is handed. The day select is an uncontrolled filter with an
/// `onChange` - inert until hydration, which costs nothing here because the
/// unhydrated page already shows the first day's times and books them.
export function ShowingBookingForm({
  action,
  slots,
  timezone,
}: {
  action: (state: BookingFormState, formData: FormData) => Promise<BookingFormState>
  slots: string[]
  timezone: string
}) {
  const dayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  })

  // Grouped in the PROPERTY's timezone, not the browser's. A prospect
  // booking from another state must see the day the viewing happens on
  // where the house is (D-3) - and `slots` arrives ordered, so insertion
  // order is chronological for both the days and the times inside them.
  const byDay = new Map<string, { value: string; label: string }[]>()
  for (const iso of slots) {
    const at = new Date(iso)
    const day = dayFormatter.format(at)
    const times = byDay.get(day) ?? []
    times.push({ value: iso, label: timeFormatter.format(at) })
    byDay.set(day, times)
  }
  const days = [...byDay.keys()]

  const [state, formAction] = useActionState<BookingFormState, FormData>(action, {})
  const [day, setDay] = useState(days[0] ?? '')

  if (days.length === 0) {
    return <p className="text-muted-foreground text-sm">No times are open right now. Contact us.</p>
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FormAlerts state={state} />
      <SelectField
        label="Pick a day"
        name="day"
        required
        idPrefix="showing"
        defaultValue={day}
        options={days.map((d) => ({ value: d, label: d }))}
        onChange={(event) => setDay(event.target.value)}
      />
      {/* KEYED ON THE DAY so switching days clears a time already chosen for
          the previous one. The field is uncontrolled, so changing its options
          would otherwise leave the old selection index sitting on a different
          time. The key is stable across a form submission - the day does not
          change when the action responds - so this is not the `formVersion`
          trap that throws a live region away on every dispatch. */}
      <SelectField
        key={day}
        label="Pick a time"
        name="slot"
        required
        idPrefix="showing"
        options={byDay.get(day) ?? byDay.get(days[0]) ?? []}
      />
      <SubmitButton label="Book this showing" />
    </form>
  )
}
