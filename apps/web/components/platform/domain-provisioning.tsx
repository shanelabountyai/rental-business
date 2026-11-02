'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import { DnsRecordList } from '@/components/platform/email-provisioning.tsx'
import type { DnsRecord } from '@/lib/integrations/resend-provisioning.ts'
import type { OrgInviteFormState } from '@/lib/platform/org-actions.ts'

export type DomainProvisioningView = {
  /// The row's status, or null when nothing was ever started.
  status: string | null
  /// Vercel's words for an unverified or failed domain, verbatim (PRD 11 §4.4).
  statusReason: string | null
  domain: string | null
  records: DnsRecord[]
  /// The host the org is served on now: the custom domain once verified.
  servedOn: string
  startedLabel: string | null
  polledLabel: string | null
}

const words = (status: string) => status.toLowerCase().replaceAll('_', ' ')

/**
 * The custom domain half of the integrations panel (R-276, PRD 10 §4), on the
 * shape of email-provisioning.tsx: the domain, the records to publish,
 * verification with Vercel's reason verbatim, and start / re-poll / retire
 * under `integration.provision`. One `FormAlerts`, outside every conditional.
 */
export function DomainProvisioningPanel({
  action,
  slug,
  view,
  canProvision,
}: {
  action: (state: OrgInviteFormState, formData: FormData) => Promise<OrgInviteFormState>
  slug: string
  view: DomainProvisioningView
  canProvision: boolean
}) {
  const [state, formAction] = useActionState<OrgInviteFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const startable = view.status === null || ['NOT_STARTED', 'FAILED', 'RETIRED'].includes(view.status)
  const row = (label: string, value: string | null) =>
    value && (
      <>
        <dt className="font-medium">{label}</dt>
        <dd className="min-w-0 break-words">{value}</dd>
      </>
    )

  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      <h3 className="font-semibold">Custom domain (Vercel)</h3>
      {view.status !== null && (
        <p className="break-words">
          {words(view.status)}
          {view.statusReason && <> · {view.statusReason}</>}
        </p>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {row('Served on', view.servedOn)}
        {row('Custom domain', view.domain)}
        {row('Started', view.startedLabel)}
        {row('Last polled', view.polledLabel)}
      </dl>
      {view.status === 'PROVISIONING' && (
        <>
          <p>
            Publish these records at the domain&rsquo;s DNS host. Until Vercel verifies them, the organisation stays on
            its subdomain.
          </p>
          <DnsRecordList records={view.records} />
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
                label="Custom domain"
                name="domain"
                // The email panel on the same page has a `domain` field too.
                idPrefix="custom-domain"
                required
                error={errors.domain}
                hint="The host the organisation's staff, renters and vendors will use, for example portal.example.com."
              />
              <SubmitButton label="Start custom domain setup" />
            </form>
          )}
          <div className="flex flex-wrap gap-2">
            {view.status === 'PROVISIONING' && (
              <form action={formAction}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="intent" value="poll" />
                <SubmitButton label="Re-poll Vercel" />
              </form>
            )}
            {view.status !== null && view.status !== 'RETIRED' && (
              <form action={formAction} className="flex flex-col gap-2">
                <p>Retiring removes the domain from Vercel. Everyone signed in on it is signed out, and links go to the subdomain.</p>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="intent" value="retire" />
                <SubmitButton label="Retire custom domain" />
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
