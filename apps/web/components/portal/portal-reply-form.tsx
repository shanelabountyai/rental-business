'use client'

import { useActionState } from 'react'
import { LiveRegion } from '@/components/auth-form.tsx'
import { SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'
import type { FormState } from '@/lib/portal/actions.ts'

// A tenant's reply box.
//
// Deliberately not the staff ReplyForm: there is no channel picker, because a
// tenant has exactly one way to send from here, and offering a choice would
// be asking them to make a decision the product should make for them. Sized
// and labelled to the portal's own baseline - 16px text, a 44px-plus button.
export function PortalReplyForm({
  action,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <LiveRegion assertive>
        {state.error && <p className="rounded-md border border-danger/35 bg-danger/6 px-3 py-2 text-base text-danger">{state.error}</p>}
      </LiveRegion>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="portal-reply" className="font-medium">
          Write a message
        </label>
        <textarea
          id="portal-reply"
          name="body"
          rows={4}
          required
          className="border-input bg-background focus-visible:ring-ring min-h-24 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        />
      </div>
      <button
        type="submit"
        className={`${SUBMIT_BUTTON_CLASSES} flex min-h-12 items-center justify-center px-4 py-2 text-base`}
      >
        Send
      </button>
    </form>
  )
}
