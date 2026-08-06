'use client'

import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { VendorFormState } from '@/lib/vendors/actions.ts'

/// A vendor pricing a job they have NOT been given (MAINT-04, R-026). Says
/// so at the top: a vendor who thinks they have the work and turns up to
/// find they never had it will not answer the next request.
export function BidForm({
  job,
  action,
  alreadyAnswered,
}: {
  job: { scope: string; address: string; unitName: string; description: string | null }
  action: (state: VendorFormState, formData: FormData) => Promise<VendorFormState>
  alreadyAnswered: boolean
}) {
  const [state, formAction] = useActionState<VendorFormState, FormData>(action, {})
  const [declining, setDeclining] = useState(false)
  const errors = state.fieldErrors ?? {}

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-4">
      <header className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">Quote request — not yet awarded</p>
        <h1 className="text-2xl font-semibold tracking-tight">{job.scope}</h1>
      </header>

      <section className="flex flex-col gap-2 rounded-md border p-4 text-sm">
        <h2 className="font-medium">Where</h2>
        <p>
          {job.address}
          <br />
          {job.unitName}
        </p>
      </section>

      {job.description && (
        <section className="flex flex-col gap-2 rounded-md border p-4 text-sm">
          <h2 className="font-medium">What was reported</h2>
          <p className="whitespace-pre-wrap">{job.description}</p>
        </section>
      )}

      {alreadyAnswered ? (
        <p className="rounded-md border p-4 text-sm">
          Thanks - we have your answer. Call the office if you need to change it.
        </p>
      ) : (
        <section className="flex flex-col gap-4 rounded-md border-2 p-4">
          <FormAlerts state={state} />
          <form action={formAction} className="flex flex-col gap-3">
            {declining ? (
              <input type="hidden" name="declined" value="true" />
            ) : (
              <TextField
                label="Your price"
                name="amountDollars"
                idPrefix="bid"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                required
                error={errors.amountCents}
              />
            )}
            <TextField
              label={declining ? 'Anything we should know? (optional)' : 'Notes (optional)'}
              name="note"
              idPrefix="bid"
            />
            <SubmitButton label={declining ? 'Not bidding on this' : 'Send my price'} />
          </form>
          <button
            type="button"
            onClick={() => setDeclining((prior) => !prior)}
            className="min-h-11 self-start text-sm underline underline-offset-4"
          >
            {declining ? 'Actually, let me quote' : "I'm not bidding on this"}
          </button>
        </section>
      )}
    </main>
  )
}
