'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { DnsRecord } from '@/lib/integrations/resend-provisioning.ts'
import type { OrgInviteFormState } from '@/lib/platform/org-actions.ts'

export type EmailProvisioningView = {
  /// The row's status, or null when nothing was ever started.
  status: string | null
  /// Resend's words for a failed verification, verbatim (PRD 11 §4.4).
  statusReason: string | null
  domain: string | null
  domainStatus: string | null
  records: DnsRecord[]
  from: string | null
  inboundAddress: string | null
  startedLabel: string | null
  polledLabel: string | null
}

const words = (status: string) => status.toLowerCase().replaceAll('_', ' ')

/**
 * The Resend half of the integrations panel (R-293b, PRD 10 §4): the domain,
 * the DNS records to publish, verification with Resend's reason verbatim, and
 * start / re-poll / retire under `integration.provision`. One `FormAlerts`,
 * mounted outside every conditional, as in sms-provisioning.tsx.
 */
export function EmailProvisioningPanel({
  action,
  slug,
  view,
  canProvision,
}: {
  action: (state: OrgInviteFormState, formData: FormData) => Promise<OrgInviteFormState>
  slug: string
  view: EmailProvisioningView
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
      <h3 className="font-semibold">Email (Resend)</h3>
      {view.status === null ? (
        <p>Not started. Until it is, email goes from the shared address under this organisation&rsquo;s name.</p>
      ) : (
        <>
          <p className="break-words">
            {words(view.status)}
            {view.statusReason && <> · {view.statusReason}</>}
          </p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            {row('Domain', view.domain)}
            {row('Verification', view.domainStatus && words(view.domainStatus))}
            {row('Sends from', view.from)}
            {row('Replies to', view.inboundAddress)}
            {row('Started', view.startedLabel)}
            {row('Last polled', view.polledLabel)}
          </dl>
          {view.status === 'PROVISIONING' && (
            <>
              <p>
                Publish these records at the domain&rsquo;s DNS host. Until Resend verifies them, email goes from the
                shared address under this organisation&rsquo;s name.
              </p>
              <ul className="flex flex-col gap-2" aria-label="DNS records">
                {view.records.map((r) => (
                  <li key={`${r.type} ${r.name} ${r.value}`} className="flex min-w-0 flex-col rounded border p-2">
                    <span className="font-medium">
                      {r.type}
                      {r.priority !== undefined && <> · priority {r.priority}</>}
                    </span>
                    <span className="break-all">{r.name}</span>
                    {/* A DKIM key has no break opportunity: break-all, or it widens a phone's page. */}
                    <code className="break-all">{r.value}</code>
                  </li>
                ))}
              </ul>
            </>
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
                label="Sending domain"
                name="domain"
                required
                error={errors.domain}
                hint="A subdomain of the organisation's own domain, for example mail.example.com."
              />
              <SubmitButton label="Start email domain provisioning" />
            </form>
          )}
          <div className="flex flex-wrap gap-2">
            {view.status === 'PROVISIONING' && (
              <form action={formAction}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="intent" value="poll" />
                <SubmitButton label="Re-poll Resend" />
              </form>
            )}
            {view.status !== null && view.status !== 'RETIRED' && (
              <form action={formAction} className="flex flex-col gap-2">
                <p>Retiring removes the domain from Resend. Email then goes from the shared address.</p>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="intent" value="retire" />
                <SubmitButton label="Retire email domain" />
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
