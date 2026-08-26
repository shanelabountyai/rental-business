'use client'

import { RATING_MAX, RATING_MIN } from '@rental/core/workorders'
import { useActionState, useState } from 'react'
import { LiveRegion, useFocusWhen } from '@/components/auth-form.tsx'
import type { VerifyFormState } from '@/lib/portal/verify-actions.ts'
import { PRIMARY_BUTTON_CLASSES } from '@/components/ui-classes.ts'

// "Was this resolved?" (MAINT-07, R-030).
//
// TWO BUTTONS, AND THE ANSWER SUBMITS ON THE TAP. The rating and the comment
// sit inside the same form, so a tenant who fills them in first has them
// carried along - but nothing waits for them. MAINT-07 says one tap, and the
// reply rate is the entire value of this feature: a PM who gets no answers
// is back to closing jobs on faith.
//
// Real <form> submissions rather than onClick handlers, so the buttons work
// before React hydrates - the lesson R-029 learned on the acknowledge button.

export function VerifyPanel({
  workOrderId,
  answered,
  verify,
}: {
  workOrderId: string
  /// The answer already on record for this round, if any. Passed from the
  /// server rather than left to client state: `revalidatePath` re-renders
  /// this page the moment the answer lands, and a confirmation that lived
  /// only in the component's own state would vanish with it - the tenant
  /// would tap, watch the question disappear, and have no idea whether it
  /// worked. It also means the acknowledgement survives a reload.
  answered: { resolved: boolean } | null
  verify: (previous: VerifyFormState, formData: FormData) => Promise<VerifyFormState>
}) {
  const [state, action, pending] = useActionState<VerifyFormState, FormData>(verify, {})
  // `state.notice`, NOT `notice` — the latter is also true for a job answered
  // on a previous visit, and focusing then would yank focus from somebody who
  // had merely navigated here (R-101d).
  const thanksRef = useFocusWhen<HTMLHeadingElement>(Boolean(state.notice))
  const [rating, setRating] = useState<number | null>(null)

  const notice =
    state.notice ??
    (answered
      ? answered.resolved
        ? 'Thanks — we have closed this off.'
        : 'Thanks for telling us. We have reopened it; you do not need to report it again.'
      : null)

  if (notice) {
    return (
      <section
        aria-labelledby="verify"
        className="flex flex-col gap-2 rounded-md border p-4"
      >
        {/* Focused after answering, so the whole new context is announced —
            heading, section and text — rather than a live region inside a
            container that was itself just replaced, which announces nothing.
            `tabIndex={-1}` makes it focusable programmatically without adding
            a tab stop for everybody else. */}
        <h2 id="verify" ref={thanksRef} tabIndex={-1} className="text-lg font-semibold">
          Thank you
        </h2>
        <p className="text-sm">{notice}</p>
      </section>
    )
  }

  return (
    <section
      aria-labelledby="verify"
      className="flex flex-col gap-4 rounded-md border p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="verify" className="text-lg font-semibold">
          Is it fixed?
        </h2>
        <p className="text-muted-foreground text-sm">
          Someone has finished the work. Before we close it off we would rather
          hear from you than assume.
        </p>
      </div>

      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="workOrderId" value={workOrderId} />
        <input type="hidden" name="rating" value={rating ?? ''} />

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">
            How did it go? <span className="text-muted-foreground">(optional)</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {Array.from(
              { length: RATING_MAX - RATING_MIN + 1 },
              (_, index) => RATING_MIN + index,
            ).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={rating === value}
                onClick={() => setRating(rating === value ? null : value)}
                // `focus-visible:ring-ring` is not optional here (R-107a):
                // without it Tailwind v4 falls back to `currentcolor`, and on
                // the SELECTED button the current colour is `--background` —
                // so the focus ring on the rating a tenant had just chosen was
                // white on white while every unselected one showed fine.
                className={`focus-visible:ring-ring min-h-11 min-w-11 rounded-md border text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none ${
                  rating === value ? 'bg-foreground text-background' : 'border-input'
                }`}
              >
                {value}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">
            Anything we should know?{' '}
            <span className="text-muted-foreground">(optional)</span>
          </span>
          <textarea
            name="comment"
            rows={3}
            className="border-input bg-background focus-visible:ring-ring rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          />
        </label>

        {/*
          The two answers, side by side and equally weighted. "No" is not a
          secondary action buried under the happy path - a tenant who has to
          hunt for it is a tenant who taps Yes to get the screen to go away,
          and a false Yes is worse than no answer at all.
        */}
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            name="resolved"
            value="yes"
            disabled={pending}
            className={`${PRIMARY_BUTTON_CLASSES} flex-1 disabled:opacity-60`}
          >
            Yes, it is fixed
          </button>
          <button
            type="submit"
            name="resolved"
            value="no"
            disabled={pending}
            className="focus-visible:ring-ring border-input min-h-11 flex-1 rounded-md border px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
          >
            No, it is not
          </button>
        </div>

        <p className="text-muted-foreground text-sm">
          If it is not fixed, saying so reopens it — you do not need to report it
          again.
        </p>

        <LiveRegion assertive>
          {state.error && (
            <p className="text-sm text-red-700">{state.error}</p>
          )}
        </LiveRegion>
      </form>
    </section>
  )
}
