'use client'

import { useActionState, useId } from 'react'
import { useFormStatus } from 'react-dom'
import { FormAlerts, pendingButtonProps } from '@/components/auth-form.tsx'
import { runImport, type ImportFormState } from '@/lib/import/actions.ts'

const INITIAL: ImportFormState = {}

/**
 * The dry-run diff and commit, as one plain `<form>` with two NAMED submit
 * buttons (`intent=preview` / `intent=commit`) rather than client-managed
 * steps - see `runImport`'s own comment for why. A named `<button
 * type="submit">`'s own name/value is standard HTML, included in the
 * FormData only for whichever button was actually pressed, so this needs no
 * JavaScript to pick the right branch.
 *
 * Not `SubmitButton` (components/auth-form.tsx): that component hard-codes
 * its own label and carries no name/value, exactly the case its sibling
 * `pendingButtonProps` says to spread instead of use it.
 *
 * The CSV text a preview already parsed travels forward in a hidden field,
 * so pressing "Import these rows" does not require re-choosing the file.
 */
export function ImportForm() {
  const [state, formAction] = useActionState(runImport, INITIAL)
  const fileId = useId()

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormAlerts state={state} />
      {state.csvText != null && <input type="hidden" name="csvText" value={state.csvText} />}

      <div className="flex flex-col gap-2">
        <label htmlFor={fileId} className="text-sm font-medium">
          CSV file
        </label>
        <input
          id={fileId}
          name="file"
          type="file"
          accept=".csv,text/csv"
          className="min-h-11 text-base"
        />
        <p className="text-muted-foreground text-sm">
          One row per (tenant, lease) — a lease with roommates is two rows
          sharing the same property, unit and start date. Required columns:
          legal entity name, the property address, a unit name, the
          tenant&rsquo;s name, the lease start date and the monthly rent. See
          the column
          reference below.
        </p>
      </div>

      {state.headerErrors && state.headerErrors.length > 0 && (
        <ul className="list-disc rounded-md border border-red-300 bg-red-50 px-6 py-3 text-sm text-red-900">
          {state.headerErrors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {state.summary && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border p-4 text-sm sm:grid-cols-3">
          <dt className="text-muted-foreground">Rows read</dt>
          <dd className="col-span-1 sm:col-span-2">{state.rowCount}</dd>
          <dt className="text-muted-foreground">New legal entities</dt>
          <dd className="col-span-1 sm:col-span-2">{state.summary.legalEntitiesToCreate}</dd>
          <dt className="text-muted-foreground">New properties</dt>
          <dd className="col-span-1 sm:col-span-2">{state.summary.propertiesToCreate}</dd>
          <dt className="text-muted-foreground">New units</dt>
          <dd className="col-span-1 sm:col-span-2">{state.summary.unitsToCreate}</dd>
          <dt className="text-muted-foreground">New leases</dt>
          <dd className="col-span-1 sm:col-span-2">{state.summary.leasesToCreate}</dd>
          <dt className="text-muted-foreground">New tenants</dt>
          <dd className="col-span-1 sm:col-span-2">{state.summary.tenantsToCreate}</dd>
        </dl>
      )}

      {state.rowErrors && state.rowErrors.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Per-row errors</caption>
            <thead className="bg-muted">
              <tr>
                <th scope="col" className="px-3 py-2">
                  Line
                </th>
                <th scope="col" className="px-3 py-2">
                  Field
                </th>
                <th scope="col" className="px-3 py-2">
                  Problem
                </th>
              </tr>
            </thead>
            <tbody>
              {state.rowErrors.map((error, i) => (
                <tr key={`${error.line}-${error.field}-${i}`} className="border-t">
                  <td className="px-3 py-2">{error.line}</td>
                  <td className="px-3 py-2">{error.field}</td>
                  <td className="px-3 py-2">{error.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <NamedSubmitButton intent="preview" label="Preview" variant="secondary" />
        {state.ok && <NamedSubmitButton intent="commit" label="Import these rows" variant="primary" />}
      </div>
    </form>
  )
}

function NamedSubmitButton({
  intent,
  label,
  variant,
}: {
  intent: 'preview' | 'commit'
  label: string
  variant: 'primary' | 'secondary'
}) {
  const { pending } = useFormStatus()
  const classes =
    variant === 'primary'
      ? 'bg-primary text-primary-foreground'
      : 'border bg-background text-foreground'
  return (
    <button
      type="submit"
      name="intent"
      value={intent}
      {...pendingButtonProps(pending)}
      className={`min-h-11 rounded-md px-4 py-2 text-base font-medium aria-disabled:cursor-not-allowed focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none ${classes}`}
    >
      {pending ? 'Working…' : label}
    </button>
  )
}
