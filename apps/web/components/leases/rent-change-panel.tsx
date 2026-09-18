'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextareaField } from '@/components/form/field.tsx'
import type { LeaseFormState } from '@/lib/leases/actions.ts'

// A scheduled rent increase (LEASE-09, R-225): what it is, whether its
// notice has been served, and the way to withdraw it. Mounted on every
// running lease, scheduled change or not, so the confirmation of a withdrawal
// is not unmounted by the withdrawal itself (CLAUDE.md's result-region trap).

export function RentChangePanel({
  scheduled,
  cancel,
}: {
  scheduled: { summary: string; noticeLine: string; noticeHref: string } | null
  cancel: (state: LeaseFormState, formData: FormData) => Promise<LeaseFormState>
}) {
  const [state, action] = useActionState<LeaseFormState, FormData>(cancel, {})
  return (
    <form action={action} className="flex flex-col gap-3">
      <FormAlerts state={state} />
      {scheduled && (
        <div className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50">
          <p className="font-medium break-words">{scheduled.summary}</p>
          <p className="break-words">
            {scheduled.noticeLine}{' '}
            <Link href={scheduled.noticeHref} className="underline">
              Open the rent increase notice
            </Link>
          </p>
          <TextareaField
            label="Why withdraw this rent increase?"
            name="cancelReason"
            idPrefix="rent-change"
            error={state.fieldErrors?.cancelReason}
            rows={2}
          />
          <SubmitButton label="Withdraw the increase" />
        </div>
      )}
    </form>
  )
}
