'use client'

import { formatCents } from '@rental/core/money'
import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import type { WaiverFormState } from '@/lib/ledger/waivers.ts'

// Fees, and forgiving one (PAY-04, R-041).
//
// WHY THIS IS NOT PART OF THE LEDGER PANEL. That table is a projection of
// Stripe and says so: "nothing here is editable... a screen offering to
// change it would be offering something the product cannot honour." A waiver
// does not edit the ledger — it forgives a CHARGE and posts a credit, which
// then arrives on the ledger like everything else. Two different objects, so
// two different sections.
//
// This screen exists because the product started charging automatically
// before it could stop. The nightly job assesses late fees from jurisdiction
// config; until this shipped, `waiveCharge()` was written, tested, and
// callable by nothing — so a fee could be raised and not forgiven.

export interface FeeView {
  id: string
  type: string
  amountCents: number
  description: string
  dueOn: string
  waivedAt: string | null
  waiveReason: string | null
  waivedByName: string | null
}

const TYPE_WORDS: Record<string, string> = {
  LATE_FEE: 'Late fee',
  NSF_FEE: 'Returned payment fee',
}

function WaiveForm({
  fee,
  action,
}: {
  fee: FeeView
  action: (state: WaiverFormState, formData: FormData) => Promise<WaiverFormState>
}) {
  const [state, formAction] = useActionState<WaiverFormState, FormData>(action, {})
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start text-sm underline underline-offset-2"
      >
        Waive this fee
      </button>
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="chargeId" value={fee.id} />
      <FormAlerts state={state} />
      <label htmlFor={`reason-${fee.id}`} className="text-sm font-medium">
        Why is this being waived?
      </label>
      {/* REQUIRED, and the action refuses without it. "Why" is the first
          question in a fair-housing review, and a hundred waivers with an
          empty reason column are indistinguishable from an arbitrary
          pattern. */}
      <input
        id={`reason-${fee.id}`}
        name="reason"
        type="text"
        placeholder="First late payment in two years"
        className="rounded-md border px-2 py-1.5 text-sm"
        aria-describedby={state.fieldErrors?.reason ? `reason-error-${fee.id}` : undefined}
      />
      {state.fieldErrors?.reason && (
        <p id={`reason-error-${fee.id}`} className="text-sm text-red-700 dark:text-red-400">
          {state.fieldErrors.reason}
        </p>
      )}
      <div className="flex items-center gap-3">
        <SubmitButton label={`Waive ${formatCents(fee.amountCents)}`} />
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-muted-foreground text-sm underline underline-offset-2"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

export function FeesPanel({
  fees,
  canWaive,
  mfaRequired,
  waive,
}: {
  fees: readonly FeeView[]
  canWaive: boolean
  /// True when the only thing standing between this person and waiving is a
  /// second factor. Distinguished from "not allowed at all" because the two
  /// need completely different sentences: one is a door they can open, the
  /// other is not theirs to open. Silently rendering nothing - which is what
  /// this did first - leaves somebody who holds the permission staring at a
  /// screen that looks broken.
  mfaRequired: boolean
  /// ONE action for every fee, with the charge id carried in a hidden field.
  /// A Record of per-fee bound actions was the first attempt and did not
  /// survive the Server→Client boundary - the control rendered with no
  /// accessible name and no handler, and `npm run build` did not catch it.
  waive: (state: WaiverFormState, formData: FormData) => Promise<WaiverFormState>
}) {
  if (fees.length === 0) return null

  return (
    <section aria-labelledby="fees" className="flex flex-col gap-3 border-t pt-4">
      <h2 id="fees" className="text-lg font-semibold">
        Fees
      </h2>

      <ul className="flex flex-col divide-y">
        {fees.map((fee) => (
          <li key={fee.id} className="flex flex-col gap-2 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className={fee.waivedAt ? 'text-muted-foreground' : ''}>
                <span className="font-medium">{TYPE_WORDS[fee.type] ?? fee.type}</span>
                {' · '}
                {fee.dueOn}
              </span>
              <span
                className={
                  fee.waivedAt ? 'text-muted-foreground line-through' : 'font-medium'
                }
              >
                {formatCents(fee.amountCents)}
              </span>
            </div>

            <p className="text-muted-foreground text-sm">{fee.description}</p>

            {fee.waivedAt ? (
              // The waiver record stays on screen. It is half the point: an
              // operator deciding the next waiver should be able to see the
              // last one, and PAY-04's pattern report exists because that
              // history is what fair housing turns on.
              <p className="text-sm">
                Waived{fee.waivedByName ? ` by ${fee.waivedByName}` : ''} on {fee.waivedAt}
                {fee.waiveReason ? ` — “${fee.waiveReason}”` : ''}
              </p>
            ) : canWaive ? (
              <WaiveForm fee={fee} action={waive} />
            ) : mfaRequired ? (
              <p className="text-sm">
                Waiving a fee needs two-factor verification. Sign in again with
                your authenticator to waive this one.
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground text-xs">
        Waiving posts a credit rather than deleting the charge — the fee and
        the decision to forgive it both stay on the record.
      </p>
    </section>
  )
}
