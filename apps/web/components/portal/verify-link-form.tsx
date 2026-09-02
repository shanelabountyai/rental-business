'use client'

import { useActionState } from 'react'
import { FormAlerts, useFocusWhen } from '@/components/auth-form.tsx'
import type { VerifyLinkFormState } from '@/lib/portal/verify-link-actions.ts'

// The two taps that close a work order (MAINT-07, R-032c).
//
// TWO REAL SUBMIT BUTTONS IN ONE FORM, each carrying its own value — not a
// radio group with a separate submit, and not `onClick` handlers. Three
// reasons, in order of how much they cost when ignored:
//
//   1. It works before hydration. This is the R-098 standard for anything
//      that must work on first paint, and it matters more here than almost
//      anywhere: the tenant is on a phone, on mobile data, on a link from a
//      text message, and the whole value of the feature is that they answer
//      instead of giving up.
//   2. It is one tap per answer. A radio plus a submit is two taps to say
//      one thing, and the reply rate is the entire point.
//   3. Both answers are equally easy. Making "yes" the prominent one and
//      "no" a quiet link would bias the record the product exists to keep
//      honest — a tenant whose repair is still broken must not have to hunt
//      for the way to say so.

export function VerifyLinkForm({
  action,
}: {
  // No `job` prop: the page renders the summary above this, and passing it in
  // only to ignore it invites somebody to render it twice.
  action: (
    state: VerifyLinkFormState,
    formData: FormData,
  ) => Promise<VerifyLinkFormState>
}) {
  const [state, formAction] = useActionState<VerifyLinkFormState, FormData>(action, {})
  // The panel replaces itself on success, so the `FormAlerts` below is a
  // brand-new node carrying its own text and announces nothing, and the button
  // that had focus is gone - a tenant answering with a keyboard or a screen
  // reader was returned to the top of the document in silence (R-114).
  // Focusing the heading of what replaced it announces the whole new context;
  // this is one of the three panels `useFocusWhen` was written for and it was
  // still not using it.
  const answeredHeading = useFocusWhen<HTMLHeadingElement>(Boolean(state.answered))

  // Once answered, the buttons go. Leaving them would invite a second tap
  // that can only ever be refused.
  if (state.answered) {
    return (
      <div className="flex flex-col gap-3">
        <h2 ref={answeredHeading} tabIndex={-1} className="text-base font-medium">
          Your answer is recorded
        </h2>
        <FormAlerts state={state} />
        <p className="text-muted-foreground text-sm">
          You can close this page. If anything changes, message us from your
          portal or call the office.
        </p>
      </div>
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormAlerts state={state} />

      <div className="flex flex-col gap-3">
        <button
          type="submit"
          name="resolved"
          value="yes"
          className="focus-visible:ring-ring min-h-14 rounded-md bg-emerald-700 px-4 text-base font-medium text-white focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none hover:bg-emerald-800"
        >
          Yes, it&rsquo;s fixed
        </button>
        <button
          type="submit"
          name="resolved"
          value="no"
          className="border-input focus-visible:ring-ring min-h-14 rounded-md border-2 px-4 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none hover:bg-secondary"
        >
          No, it&rsquo;s still a problem
        </button>
      </div>

      {/* Optional, and after the buttons on purpose. Anything above them is
          something a tenant has to scroll past to answer. */}
      <details>
        <summary className="min-h-11 cursor-pointer text-sm underline underline-offset-2">
          Add a note (optional)
        </summary>
        <div className="flex flex-col gap-1 pt-2">
          <label htmlFor="verify-comment" className="text-sm font-medium">
            Anything you want us to know?
          </label>
          <textarea
            id="verify-comment"
            name="comment"
            rows={3}
            className="border-input focus-visible:ring-ring rounded-md border px-2 py-1.5 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            placeholder="The leak stopped but the cabinet is still damp"
          />
          <p className="text-muted-foreground text-xs">
            If you tap &ldquo;still a problem&rdquo;, this note goes to whoever picks it
            up next.
          </p>
        </div>
      </details>
    </form>
  )
}
