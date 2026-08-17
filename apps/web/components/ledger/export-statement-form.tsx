'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { FormState } from '@/lib/ledger/statement.ts'

// PAY-09 (R-052): "generate a court/dispute-ready PDF ledger statement for
// any lease and period."
//
// BOTH DATES ARE OPTIONAL, and the default of leaving them empty is the whole
// tenancy - which is the request people actually make. A required window
// would make the common case the fiddly one, and would invite somebody to
// type a start date that quietly excludes the arrears the statement is meant
// to establish.
//
// `<input type="date">` rather than a picker component: the native control is
// keyboard-accessible, localized and understood by every assistive
// technology, which is a WCAG 2.1 AA acceptance criterion on this work rather
// than a nicety.
export function ExportStatementForm({
  action,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex flex-col gap-3 sm:max-w-md">
      <FormAlerts state={state} />
      <p className="text-muted-foreground text-sm">
        Produces a chronological statement of account in plain language, with
        the balance carried forward into the period. Leave the dates empty for
        the whole tenancy.
      </p>
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1.5">
          {/* "Statement from", not "From". The lease page already carries a
              recurring-charge panel labelled "Billing from", and a bare
              "From" is ambiguous to a screen reader working through the page
              linearly - it announces a date field with no idea which of the
              page's several date ranges it belongs to. The e2e run caught it
              as a strict-mode collision, which is the same defect wearing a
              test's clothes. */}
          <label htmlFor="statement-from" className="text-sm font-medium">
            Statement from
          </label>
          <input
            id="statement-from"
            name="fromDate"
            type="date"
            className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="statement-to" className="text-sm font-medium">
            Statement to
          </label>
          <input
            id="statement-to"
            name="toDate"
            type="date"
            className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          />
        </div>
      </div>
      <SubmitButton label="Produce statement" />
      {state.documentId && (
        <Link
          href={`/api/documents/${state.documentId}/file`}
          className="focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          Open the statement
        </Link>
      )}
    </form>
  )
}
