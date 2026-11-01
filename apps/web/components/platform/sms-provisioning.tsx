'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { OrgInviteFormState } from '@/lib/platform/org-actions.ts'

export type SmsProvisioningView = {
  /// The row's status, or null when nothing was ever started.
  status: string | null
  /// Twilio's words for the failing step, verbatim (PRD 11 §4.4).
  statusReason: string | null
  phoneNumber: string | null
  brand: { status: string; reason: string | null } | null
  campaign: { status: string; reason: string | null } | null
  startedLabel: string | null
  polledLabel: string | null
}

const words = (status: string) => status.toLowerCase().replaceAll('_', ' ')

/**
 * The Twilio half of the integrations panel (R-292b, PRD 10 §3.1): each step's
 * status with the provider's reason verbatim, and start / re-poll / retire
 * under `integration.provision`. One `FormAlerts`, mounted outside every
 * conditional, so a press that changes which buttons show still announces.
 */
export function SmsProvisioningPanel({
  action,
  slug,
  view,
  canProvision,
}: {
  action: (state: OrgInviteFormState, formData: FormData) => Promise<OrgInviteFormState>
  slug: string
  view: SmsProvisioningView
  canProvision: boolean
}) {
  const [state, formAction] = useActionState<OrgInviteFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const startable = view.status === null || ['NOT_STARTED', 'FAILED', 'RETIRED'].includes(view.status)
  const step = (label: string, review: SmsProvisioningView['brand'], none: string) => (
    <>
      <dt className="font-medium">{label}</dt>
      <dd className="min-w-0 break-words">
        {review ? words(review.status) : none}
        {review?.reason && <> · {review.reason}</>}
      </dd>
    </>
  )

  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      <h3 className="font-semibold">SMS (Twilio)</h3>
      {view.status === null ? (
        <p>Not started. Until it is, this organisation has no texting number of its own.</p>
      ) : (
        <>
          <p className="break-words">
            {words(view.status)}
            {view.statusReason && <> · {view.statusReason}</>}
          </p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="font-medium">Number</dt>
            <dd className="min-w-0 break-words">{view.phoneNumber ?? 'none'}</dd>
            {step('Brand', view.brand, 'not registered')}
            {step('Campaign', view.campaign, 'not registered yet')}
            {view.startedLabel && (
              <>
                <dt className="font-medium">Started</dt>
                <dd className="min-w-0 break-words">{view.startedLabel}</dd>
              </>
            )}
            {view.polledLabel && (
              <>
                <dt className="font-medium">Last polled</dt>
                <dd className="min-w-0 break-words">{view.polledLabel}</dd>
              </>
            )}
          </dl>
          {view.status === 'PROVISIONING' && (
            <p>
              Until the campaign is approved, texts go only to the owners&rsquo; own phones; every other text is
              recorded as not sent.
            </p>
          )}
        </>
      )}
      <FormAlerts state={state} />
      {canProvision && (
        <div className="flex flex-col gap-3">
          {startable && (
            <form action={formAction} className="flex flex-col gap-3">
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="intent" value="start" />
              <TextField
                label="Area code for the texting number"
                name="areaCode"
                required
                inputMode="numeric"
                error={errors.areaCode}
                hint="Three digits, for example 512."
              />
              <SubmitButton label="Start SMS provisioning" />
            </form>
          )}
          <div className="flex flex-wrap gap-2">
            {view.status === 'PROVISIONING' && (
              <form action={formAction}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="intent" value="poll" />
                <SubmitButton label="Re-poll Twilio" />
              </form>
            )}
            {view.status !== null && view.status !== 'RETIRED' && (
              <form action={formAction} className="flex flex-col gap-2">
                <p>Retiring closes the subaccount and releases the number. Starting again buys a new one.</p>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="intent" value="retire" />
                <SubmitButton label="Retire SMS" />
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
