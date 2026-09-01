'use client'

import { useActionState } from 'react'
import {
  FormAlerts,
  SubmitButton,
  useFocusWhen,
  useFormVersion,
} from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import { VendorHelpLine } from '@/components/vendors/vendor-help-line.tsx'
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
  const errors = state.fieldErrors ?? {}
  // What was typed, handed back after a refusal, and the `key` that makes it
  // survive React 19's post-dispatch reset (R-114, `useFormVersion`).
  const echoed = state.values ?? {}
  const formVersion = useFormVersion(state)
  // Answering flips `alreadyAnswered` on the server, so the whole section
  // holding this form - and the region that would have carried "thanks, we
  // have your price" - unmounts in the same pass that produced the message.
  // Focusing the heading of the panel that replaced it is the fix
  // `useFocusWhen` was written for.
  const answeredHeading = useFocusWhen<HTMLHeadingElement>(Boolean(state.notice))

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

      {/* OUTSIDE the branch below, because answering is what unmounts it
          (R-044's rule). A region that arrives with its text already in it
          announces nothing, and a refusal needs somewhere to land. */}
      <FormAlerts state={state} />

      {alreadyAnswered ? (
        <section className="flex flex-col gap-2 rounded-md border p-4">
          <h2 ref={answeredHeading} tabIndex={-1} className="text-base font-medium">
            Your answer is recorded
          </h2>
          {/* The sentence this replaces said "call the office" and gave no
              number, on a surface built by the same programme that wrote
              `VendorHelpLine` for exactly that dead end (R-114). */}
          <p className="text-sm">If you need to change it, give us a ring.</p>
          <VendorHelpLine />
        </section>
      ) : (
        <section className="flex flex-col gap-4 rounded-md border-2 p-4">
          {/* TWO FORMS, NOT ONE FORM AND A `useState` TOGGLE - the same fix
              R-098 made to the accept/decline/propose section of the dispatch
              page, for the same two reasons (R-114). The toggle was an
              `onClick`, so before hydration the only answer a vendor could
              give was a price: "I can't quote this" needed JavaScript to
              reach. And flipping it destroyed the button holding focus.
              `<details>` keeps focus on its `<summary>` and discloses with no
              JavaScript at all. */}
          <form key={formVersion} action={formAction} className="flex flex-col gap-3">
            <TextField
              label="Your price"
              // R-140's demo walk: this was the only money field in the
              // product with no unit on it, and the only one a STRANGER
              // fills in - every staff-facing one already says "dollars"
              // (`record-invoice-form`, `create-work-order-form`,
              // `add-capital-improvement-form`). A vendor reading "Your
              // price" over an empty box has nothing telling them whether
              // 340000 is the answer or a hundredfold mistake.
              hint="Whole or fractional dollars, parts and labour included."
              name="amountDollars"
              idPrefix="bid"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              required
              defaultValue={echoed.amountDollars}
              error={errors.amountCents}
            />
            <TextField
              label="Notes (optional)"
              name="note"
              idPrefix="bid"
              defaultValue={echoed.note}
            />
            <SubmitButton label="Send my price" />
          </form>

          <details className="rounded-md border p-3">
            <summary className="min-h-11 cursor-pointer text-sm underline underline-offset-4">
              I&rsquo;m not bidding on this
            </summary>
            {/* Its own `idPrefix`: both forms are in the DOM at once and both
                carry a field called `note`, which would otherwise be two
                inputs sharing one id. */}
            <form
              key={formVersion}
              action={formAction}
              className="flex flex-col gap-3 pt-3"
            >
              <input type="hidden" name="declined" value="true" />
              <TextField
                label="Anything we should know? (optional)"
                name="note"
                idPrefix="bid-decline"
                defaultValue={echoed.note}
              />
              <SubmitButton label="Not bidding on this" />
            </form>
          </details>
        </section>
      )}
    </main>
  )
}
