'use client'

import { OUTBOUND_CHANNELS } from '@rental/core/comms'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { FieldError, SelectField } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/comms/actions.ts'
import { INPUT_CLASSES } from '@/components/ui-classes.ts'

const CHANNEL_LABELS: Record<string, string> = {
  SMS: 'Text',
  EMAIL: 'Email',
  PORTAL: 'Portal',
}

// COMM-01: "Given in-platform texting, when used, then it must be as fast as
// native texting (speed is the anti-side-channel feature - if it's slower,
// staff will bypass it under pressure)."
//
// Hence a plain textarea and a send button on the transcript itself, with no
// modal, no navigation and no template picker in the way. A staff member
// standing in a driveway must not have a reason to reach for their own phone
// instead - a message sent from a personal number is a message this product
// has no record of, which is the entire evidence trail defeated by a UI
// inconvenience.
export function ReplyForm({
  action,
  channels,
  recipient,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  /// Only the channels this participant can actually be reached on - a
  /// tenant with no phone gets no SMS option rather than an error after
  /// typing.
  channels: readonly string[]
  /// Who this reaches, folded into the field label and the button (R-115).
  ///
  /// A work order with both parties renders this form AND the vendor one on
  /// the same assembled page, and both buttons said "Send": by ear they were
  /// the same control, and one texts the tenant while the other texts the
  /// vendor. The `<h3>` above each is not part of either button's accessible
  /// name. Omitted on a message thread, where there is one participant and
  /// nothing to confuse it with.
  recipient?: string
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  const available = OUTBOUND_CHANNELS.filter((channel) =>
    channels.includes(channel),
  )

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <FormAlerts state={state} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="field-reply-body" className="text-sm font-medium">
          {recipient ? `Reply to ${recipient}` : 'Reply'}
        </label>
        <textarea
          id="field-reply-body"
          name="body"
          rows={3}
          required
          aria-invalid={Boolean(errors.body) || undefined}
          aria-describedby={errors.body ? 'field-reply-body-error' : undefined}
          className={INPUT_CLASSES}
        />
        <FieldError id="field-reply-body-error" message={errors.body} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-40">
          <SelectField
            label="Send by"
            name="channel"
            idPrefix="reply"
            required
            error={errors.channel}
            defaultValue={available[0]}
            placeholder="Choose…"
            options={available.map((channel) => ({
              value: channel,
              label: CHANNEL_LABELS[channel] ?? channel,
            }))}
          />
        </div>
        <SubmitButton label={recipient ? `Send to ${recipient}` : 'Send'} />
      </div>
    </form>
  )
}
