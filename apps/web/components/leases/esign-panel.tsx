'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextareaField } from '@/components/form/field.tsx'
import type { EsignFormState } from '@/lib/leases/esign-staff-actions.ts'

// Generating a lease and sending it for e-signature (LEASE-06, DOC-02,
// R-063). Same shape every other lifecycle panel here uses: pre-computed,
// already-bound server actions, and only what is currently legal shown.

type Action = (state: EsignFormState, formData: FormData) => Promise<EsignFormState>

export interface EsignSignerView {
  id: string
  order: number
  role: string
  name: string
  status: string
  viewedAt: string | null
  signedAt: string | null
  signedName: string | null
}

export interface EsignEnvelopeView {
  status: string
  addendumKeys: string[]
  draftDocumentId: string | null
  executedDocumentId: string | null
  sentAt: string | null
  completedAt: string | null
  voidedAt: string | null
  signers: readonly EsignSignerView[]
}

const STATUS_WORDS: Record<string, string> = {
  DRAFT: 'Generated, not yet sent',
  SENT: 'Sent — waiting on signatures',
  PARTIALLY_SIGNED: 'Partially signed',
  COMPLETED: 'Completed — lease is active',
  VOIDED: 'Withdrawn',
}

const SIGNER_STATUS_WORDS: Record<string, string> = {
  PENDING: 'Not sent yet',
  SENT: 'Link sent',
  VIEWED: 'Opened the document',
  SIGNED: 'Signed',
  DECLINED: 'Declined',
}

export function EsignPanel({
  canExecute,
  mfaRequired,
  offerGenerate,
  envelope,
  generateAction,
  voidAction,
}: {
  canExecute: boolean
  /// R-004: `lease.execute` is privileged. Distinct from simply `!canExecute`
  /// the same way FeesPanel's own `mfaRequired` is - "cannot" and "can once
  /// verified" are different messages to a manager who holds the permission.
  mfaRequired: boolean
  /// Only DRAFT leases can be sent - the page decides, same rule every
  /// other offer here follows rather than re-checking status in JSX.
  offerGenerate: boolean
  envelope: EsignEnvelopeView | null
  generateAction: Action
  voidAction: Action
}) {
  if (!canExecute && !mfaRequired && !envelope) return null

  return (
    <section aria-labelledby="esign" className="flex flex-col gap-4 border-t pt-4">
      <h2 id="esign" className="text-lg font-semibold">
        Lease document &amp; e-signature
      </h2>

      {envelope ? (
        <div className="flex flex-col gap-3 text-sm">
          <p>
            <span className="font-medium">{STATUS_WORDS[envelope.status] ?? envelope.status}</span>
            {envelope.addendumKeys.length > 0 && (
              <span className="text-muted-foreground">
                {' '}
                · {envelope.addendumKeys.length} addend
                {envelope.addendumKeys.length === 1 ? 'um' : 'a'} included
              </span>
            )}
          </p>

          <ul className="flex flex-col gap-1">
            {envelope.signers.map((signer) => (
              <li key={signer.id} className="flex items-center justify-between gap-2">
                <span>
                  {signer.order}. {signer.name}{' '}
                  <span className="text-muted-foreground">
                    ({signer.role === 'TENANT' ? 'tenant' : 'guarantor'})
                  </span>
                </span>
                <span className="text-muted-foreground">
                  {SIGNER_STATUS_WORDS[signer.status] ?? signer.status}
                  {signer.signedAt && ` · ${signer.signedAt}`}
                </span>
              </li>
            ))}
          </ul>

          {(envelope.executedDocumentId ?? envelope.draftDocumentId) && (
            <a
              href={`/api/documents/${envelope.executedDocumentId ?? envelope.draftDocumentId}/file`}
              className="w-fit underline underline-offset-4"
            >
              {envelope.executedDocumentId ? 'View executed lease' : 'View draft lease'}
            </a>
          )}

          {canExecute && envelope.status !== 'COMPLETED' && envelope.status !== 'VOIDED' && (
            <VoidForm action={voidAction} />
          )}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">No document has been generated yet.</p>
      )}

      {offerGenerate &&
        (canExecute ? (
          <GenerateForm action={generateAction} />
        ) : mfaRequired ? (
          <p className="text-sm">
            Sending a lease for signature needs two-factor verification. Sign in again
            with your authenticator to send this one.
          </p>
        ) : null)}
    </section>
  )
}

function GenerateForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState<EsignFormState, FormData>(action, {})
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <SubmitButton label="Generate & send for e-signature" />
    </form>
  )
}

function VoidForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState<EsignFormState, FormData>(action, {})
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <FormAlerts state={state} />
      <TextareaField
        label="Why is this envelope being withdrawn?"
        name="reason"
        required
        hint="Written to the record - a lease sent for signature and then pulled back needs a stated reason."
      />
      <SubmitButton label="Void this envelope" />
    </form>
  )
}
