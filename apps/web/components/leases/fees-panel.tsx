'use client'

import { formatCents } from '@rental/core/money'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { FieldError } from '@/components/form/field.tsx'
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
  label,
  action,
}: {
  fee: FeeView
  /// What this fee IS, in words, for the trigger's accessible name.
  label: string
  action: (state: WaiverFormState, formData: FormData) => Promise<WaiverFormState>
}) {
  const [state, formAction] = useActionState<WaiverFormState, FormData>(action, {})

  return (
    // M7 (R-099), all three of them mine from R-041. `<details>` rather than
    // a `useState` toggle because the toggle had each trigger unmount
    // ITSELF - opening the form destroyed the button holding focus, so a
    // keyboard user landed back at the top of the document and a screen
    // reader announced nothing. A `<summary>` survives its own activation.
    //
    // It also works before hydration, and it removes the Cancel button
    // entirely: closing a disclosure is what the summary already does.
    //
    // Stays open when the server rejected the reason, or the error would be
    // hidden behind a collapsed panel the moment it arrived.
    <details open={Boolean(state.fieldErrors?.reason || state.error)}>
      {/* NOT "Waive this fee". Every fee on the lease rendered that same
          string, so a screen-reader user listing the controls on the page
          heard "Waive this fee" N times with nothing to tell them apart. */}
      <summary className="min-h-11 cursor-pointer text-sm underline underline-offset-2">
        Waive this {label} of {formatCents(fee.amountCents)}
      </summary>

      <form action={formAction} className="flex flex-col gap-2 pt-2">
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
          className="border-input focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          aria-describedby={state.fieldErrors?.reason ? `reason-error-${fee.id}` : undefined}
        />
        {/* `FieldError` carries role="alert"; the bare <p> this replaces
            announced nothing when the server rejected the reason. */}
        <FieldError id={`reason-error-${fee.id}`} message={state.fieldErrors?.reason} />
        <SubmitButton label={`Waive ${formatCents(fee.amountCents)}`} />
      </form>
    </details>
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
              <WaiveForm
                fee={fee}
                label={(TYPE_WORDS[fee.type] ?? fee.type).toLowerCase()}
                action={waive}
              />
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
