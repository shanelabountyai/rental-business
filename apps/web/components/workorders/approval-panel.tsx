'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { WorkOrderFormState } from '@/lib/workorders/actions.ts'

// The owner's decision surface (MAINT-04, R-026).
//
// "Approve/Deny/Ask from phone in <=2 taps with photos and estimate
// visible." Two taps means Approve is a single button that is already on
// screen - not behind a disclosure, not needing a field filled first. Deny
// and Ask each need one more tap to reveal their required field, which is
// the honest reading: a denial without a reason is worthless to the PM, and
// an "ask" with no question is nothing at all.
//
// The estimate and the photos are rendered ABOVE the buttons deliberately.
// Somebody approving $2,000 from a phone in a car park should have had the
// number and the picture in front of them before their thumb reached the
// button.

function money(cents: number | null): string {
  if (cents == null) return 'No estimate'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    cents / 100,
  )
}

export function ApprovalPanel({
  workOrder,
  photos,
  decideAction,
  canDecide,
  needsMfa,
}: {
  workOrder: {
    scope: string
    estimateCents: number | null
    approvedAmountCents: number | null
    actualTotalCents: number | null
    approvalQuestion: string | null
    propertyName: string
    unitName: string
  }
  photos: readonly { id: string; fileName: string; href: string }[]
  decideAction: (state: WorkOrderFormState, formData: FormData) => Promise<WorkOrderFormState>
  /// Holds workorder.approve on this property. Somebody who can merely READ
  /// the work order sees the pending state and no buttons.
  canDecide: boolean
  /// Set when the ONLY thing standing between this actor and deciding is a
  /// second factor (ROLE-05 gates every privileged permission behind MFA).
  /// Distinct from canDecide=false, because telling the one person who can
  /// act that somebody else has to is a dead end - R-026 shipped that bug
  /// for about an hour before an e2e test caught it.
  needsMfa?: boolean
}) {
  const [state, formAction] = useActionState<WorkOrderFormState, FormData>(decideAction, {})
  const [mode, setMode] = useState<'idle' | 'deny' | 'ask'>('idle')
  const errors = state.fieldErrors ?? {}

  // The re-approval case reads differently from a first approval, and saying
  // so is the difference between "sign this" and "this already cost more
  // than you agreed to".
  const overrun =
    workOrder.approvedAmountCents != null &&
    workOrder.actualTotalCents != null &&
    workOrder.actualTotalCents > workOrder.approvedAmountCents

  return (
    <div className="flex flex-col gap-4 rounded-md border-2 p-4">
      <h2 className="text-base font-medium">
        {overrun ? 'This ran over what was approved' : 'Waiting for your approval'}
      </h2>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Estimate</dt>
        <dd className="font-medium">{money(workOrder.estimateCents)}</dd>
        {workOrder.approvedAmountCents != null && (
          <>
            <dt className="text-muted-foreground">Previously approved</dt>
            <dd>{money(workOrder.approvedAmountCents)}</dd>
          </>
        )}
        {workOrder.actualTotalCents != null && (
          <>
            <dt className="text-muted-foreground">Actually spent</dt>
            <dd className={overrun ? 'font-medium text-red-700 dark:text-red-400' : undefined}>
              {money(workOrder.actualTotalCents)}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Where</dt>
        <dd>
          {workOrder.propertyName} — {workOrder.unitName}
        </dd>
      </dl>

      <p className="whitespace-pre-wrap text-sm">{workOrder.scope}</p>

      {photos.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {photos.map((photo) => (
            <li key={photo.id}>
              <Link href={photo.href} className="underline underline-offset-4">
                {photo.fileName}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {workOrder.approvalQuestion && (
        <p className="rounded-md border p-3 text-sm">
          You asked: {workOrder.approvalQuestion}
        </p>
      )}

      {!canDecide ? (
        needsMfa ? (
          <p className="text-sm">
            <Link href="/account" className="underline underline-offset-4">
              Set up your second factor
            </Link>{' '}
            to approve this. Approving a spend is a privileged action
            (ROLE-05), so it needs more than a password.
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            Waiting on somebody with approval authority.
          </p>
        )
      ) : (
        <>
          <FormAlerts state={state} />

          {mode === 'idle' && (
            <form action={formAction} className="flex flex-col gap-3">
              <input type="hidden" name="decision" value="APPROVE" />
              <SubmitButton label={overrun ? 'Approve the higher amount' : 'Approve'} />
            </form>
          )}

          {mode === 'deny' && (
            <form action={formAction} className="flex flex-col gap-3">
              <input type="hidden" name="decision" value="DENY" />
              <TextField
                label="Why not?"
                name="denialReason"
                idPrefix="approval"
                required
                error={errors.denialReason}
                hint="The PM needs to know whether to re-scope it or drop it."
              />
              <SubmitButton label="Deny" />
            </form>
          )}

          {mode === 'ask' && (
            <form action={formAction} className="flex flex-col gap-3">
              <input type="hidden" name="decision" value="ASK" />
              <TextField
                label="What do you want to know?"
                name="question"
                idPrefix="approval"
                required
                error={errors.question}
              />
              <SubmitButton label="Send question" />
            </form>
          )}

          <div className="flex flex-wrap gap-4 text-sm">
            {mode !== 'deny' && (
              <button
                type="button"
                onClick={() => setMode('deny')}
                className="min-h-11 underline underline-offset-4"
              >
                Deny
              </button>
            )}
            {mode !== 'ask' && (
              <button
                type="button"
                onClick={() => setMode('ask')}
                className="min-h-11 underline underline-offset-4"
              >
                Ask a question
              </button>
            )}
            {mode !== 'idle' && (
              <button
                type="button"
                onClick={() => setMode('idle')}
                className="min-h-11 underline underline-offset-4"
              >
                Back
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
