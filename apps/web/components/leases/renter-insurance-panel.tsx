'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { InsuranceFormState } from '@/lib/leases/insurance-actions.ts'

// Renter's insurance tracking (LEASE-10, R-067). The certificate file is
// optional - carrier and dates recorded from a phone call are a real state
// worth having on file even before the PDF arrives.

export interface RenterInsurancePolicyView {
  id: string
  carrier: string
  policyNumber: string | null
  liabilityCents: number | null
  expiresOn: string | null
  documentId: string | null
  documentFileName: string | null
  createdAt: string
}

function statusLabel(expiresOn: string | null): { text: string; className: string } {
  if (!expiresOn) return { text: 'No expiry on file', className: 'text-muted-foreground' }
  const days = Math.round((new Date(`${expiresOn}T00:00:00Z`).getTime() - Date.now()) / 86_400_000)
  if (days < 0) return { text: `Lapsed ${Math.abs(days)}d ago`, className: 'text-red-700' }
  if (days <= 60) return { text: `Expires in ${days}d`, className: 'text-amber-800' }
  return { text: `Current, expires ${expiresOn}`, className: 'text-green-800' }
}

export function RenterInsurancePanel({
  canWrite,
  current,
  action,
}: {
  canWrite: boolean
  current: RenterInsurancePolicyView | null
  action: (state: InsuranceFormState, formData: FormData) => Promise<InsuranceFormState>
}) {
  const [state, formAction] = useActionState<InsuranceFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <section aria-labelledby="renter-insurance" className="flex flex-col gap-4 rounded-md border p-4">
      <h2 id="renter-insurance" className="text-sm font-semibold">
        Renter&rsquo;s insurance
      </h2>

      {current ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Carrier</dt>
          <dd>
            {current.carrier}
            {current.policyNumber ? ` · #${current.policyNumber}` : ''}
          </dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd className={statusLabel(current.expiresOn).className}>
            {statusLabel(current.expiresOn).text}
          </dd>
          {current.documentFileName && (
            <>
              <dt className="text-muted-foreground">Certificate</dt>
              <dd>
                <a
                  href={`/api/documents/${current.documentId}/file`}
                  className="underline underline-offset-2"
                >
                  {current.documentFileName}
                </a>
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className="text-muted-foreground text-sm">No policy on file.</p>
      )}

      {canWrite && (
        <form action={formAction} className="flex flex-col gap-4">
          <FormAlerts state={state} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField label="Carrier" name="carrier" required idPrefix="insurance" error={errors.carrier} />
            <TextField label="Policy number" name="policyNumber" idPrefix="insurance" error={errors.policyNumber} />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              label="Liability coverage ($, optional)"
              name="liabilityDollars"
              type="number"
              inputMode="decimal"
              min={0}
              idPrefix="insurance"
              error={errors.liabilityDollars}
            />
            <TextField
              label="Expires on"
              name="expiresOn"
              type="date"
              idPrefix="insurance"
              error={errors.expiresOn}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="field-insurance-file" className="text-sm font-medium">
              Certificate (optional)
            </label>
            <input
              id="field-insurance-file"
              name="file"
              type="file"
              className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            />
          </div>
          <SubmitButton label="Record policy" />
        </form>
      )}
    </section>
  )
}
