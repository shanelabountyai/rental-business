'use client'

import { useActionState } from 'react'
import { LiveRegion } from '@/components/auth-form.tsx'
import { FieldError, TextField } from '@/components/form/field.tsx'
import type { WorkOrderFormState } from '@/lib/workorders/actions.ts'
import { PRIMARY_BUTTON_CLASSES } from '@/components/ui-classes.ts'

// Verify & close (MAINT-07, R-030).
//
// The screen where the work order → invoice → property-books chain either
// holds or breaks. It holds because the invoice total is typed HERE, once,
// onto the work order — and every downstream reader (the property cost
// roll-up, R-042's QuickBooks mapping later) reads that number rather than a
// second copy of it. There is deliberately no "and also enter it in the
// books" step, because that step is what the backlog identifies as the exact
// place owners abandon software.

export interface TenantAnswer {
  resolved: boolean
  rating: number | null
  comment: string | null
  respondedAt: string
  vendorName: string | null
  round: number
}

const CAUSES = [
  { value: 'normal_wear', label: 'Normal wear' },
  { value: 'tenant_caused', label: 'Tenant-caused' },
  { value: 'unknown', label: 'Unknown' },
] as const

export function ClosePanel({
  invoiceCents,
  currentAnswer,
  history,
  closeAction,
}: {
  invoiceCents: number | null
  /// The answer for the CURRENT round, if the tenant has given one. An old
  /// answer from before a reopen is history, not a live objection.
  currentAnswer: TenantAnswer | null
  history: TenantAnswer[]
  closeAction: (
    previous: WorkOrderFormState,
    formData: FormData,
  ) => Promise<WorkOrderFormState>
}) {
  const [state, action, pending] = useActionState<WorkOrderFormState, FormData>(
    closeAction,
    {},
  )

  return (
    <section aria-labelledby="close" className="flex flex-col gap-4 border-t pt-4">
      <h2 id="close" className="text-lg font-semibold">
        Verify &amp; close
      </h2>

      {currentAnswer ? (
        <p
          className={`rounded-md border px-3 py-2 text-sm ${
            currentAnswer.resolved
              ? 'border-green-300 dark:border-green-900'
              : 'border-red-300 dark:border-red-900'
          }`}
        >
          {currentAnswer.resolved
            ? 'The tenant confirmed this is fixed'
            : 'The tenant says this is NOT fixed'}
          {currentAnswer.rating != null && ` · rated ${currentAnswer.rating}/5`}
          {currentAnswer.comment && ` — “${currentAnswer.comment}”`}
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">
          The tenant has not answered yet. You can still close this — it will be
          recorded as closed without their confirmation.
        </p>
      )}

      {history.length > 1 && (
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer">
            Earlier answers ({history.length - 1})
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {history.slice(1).map((answer) => (
              <li key={answer.round} className="text-muted-foreground">
                Round {answer.round}: {answer.resolved ? 'fixed' : 'not fixed'}
                {answer.vendorName && ` · ${answer.vendorName}`}
                {answer.comment && ` — “${answer.comment}”`}
              </li>
            ))}
          </ul>
        </details>
      )}

      <form action={action} className="flex flex-col gap-4">
        <TextField
          label="Invoice total (dollars)"
          name="invoiceDollars"
          type="number"
          min="0"
          step="1"
          inputMode="numeric"
          defaultValue={invoiceCents != null ? String(Math.round(invoiceCents / 100)) : ''}
          error={state.fieldErrors?.invoiceDollars}
          hint="What the business is actually being asked to pay. This is the number that reaches the property's books — you will not type it anywhere else."
          idPrefix="close"
        />

        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="zeroCost" value="yes" className="size-5" />
          {/*
            An explicit statement, never a default. A work order closed at $0
            by accident is a hole in the property's cost history that nobody
            notices until they are looking at a year of maintenance spend
            that is quietly wrong.
          */}
          This job cost nothing (warranty callback, or no invoice)
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Cause</legend>
          <p className="text-muted-foreground text-sm">
            Marking a job tenant-caused is what a mid-lease chargeback is built
            on, so “unknown” is the honest answer when it is.
          </p>
          <div className="flex flex-wrap gap-3">
            {CAUSES.map((cause) => (
              <label key={cause.value} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="cause"
                  value={cause.value}
                  defaultChecked={cause.value === 'unknown'}
                  className="size-5"
                />
                {cause.label}
              </label>
            ))}
          </div>
        </fieldset>

        <FieldError id="close-error" message={state.error} />
        <LiveRegion>
          {state.notice && <p className="text-sm">{state.notice}</p>}
        </LiveRegion>

        <button
          type="submit"
          disabled={pending}
          className={`${PRIMARY_BUTTON_CLASSES} self-start disabled:opacity-60`}
        >
          Close this work order
        </button>
      </form>
    </section>
  )
}
