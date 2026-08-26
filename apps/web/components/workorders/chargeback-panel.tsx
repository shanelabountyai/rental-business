'use client'

import { useActionState } from 'react'
import { LiveRegion } from '@/components/auth-form.tsx'
import { FieldError, TextField } from '@/components/form/field.tsx'
import type { WorkOrderFormState } from '@/lib/workorders/actions.ts'
import { PRIMARY_BUTTON_CLASSES } from '@/components/ui-classes.ts'

// Billing the tenant for a repair (MAINT-07, R-031).
//
// ==========================================================================
// THE AMOUNT FIELD IS THE WHOLE SCREEN. Everything else here exists to make
// the person filling it in defend the number.
//
// It is PRE-FILLED WITH THE FULL COST and editable, which is a deliberate
// pair. Pre-filled, because the full cost is the honest starting point and an
// empty box invites a round number somebody felt was fair. Editable, because
// partial fault and betterment are the normal case — a 12-year-old carpet
// replaced with a new one is not a 100% tenant cost — and a flow that could
// only charge the invoice would be used dishonestly or not at all.
//
// The ceiling is enforced on the SERVER, in `chargebackDecision`. `max` on
// the input is a courtesy that a form post does not have to respect.
// ==========================================================================

export function ChargebackPanel({
  jobCostCents,
  amountLabel,
  evidenceCount,
  blockedReason,
  postedAmount,
  postAction,
}: {
  jobCostCents: number
  /// Pre-formatted by the server. The client does no money maths.
  amountLabel: string
  evidenceCount: number
  /// Why this cannot be billed, when it cannot. Rendered instead of the form
  /// rather than as a disabled form — a form somebody cannot submit and is
  /// not told why is worse than no form.
  blockedReason: string | null
  /// Set once a chargeback exists, so the panel reports rather than offers.
  postedAmount: string | null
  postAction: (
    previous: WorkOrderFormState,
    formData: FormData,
  ) => Promise<WorkOrderFormState>
}) {
  const [state, action, pending] = useActionState<WorkOrderFormState, FormData>(
    postAction,
    {},
  )

  return (
    <section aria-labelledby="chargeback" className="flex flex-col gap-4 border-t pt-4">
      <h2 id="chargeback" className="text-lg font-semibold">
        Bill the tenant
      </h2>

      {postedAmount ? (
        <p className="rounded-md border px-3 py-2 text-sm">
          {postedAmount} has been charged to the tenant for this repair, and the
          notice was served.
        </p>
      ) : blockedReason ? (
        <p className="text-muted-foreground text-sm">{blockedReason}</p>
      ) : (
        <form action={action} className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            This repair cost {amountLabel}. Charge the tenant all of it, or the
            part that is genuinely theirs — you cannot charge more than it cost.
          </p>

          <TextField
            label="Charge the tenant (dollars)"
            name="amountDollars"
            type="number"
            min="0"
            max={String(jobCostCents / 100)}
            step="0.01"
            inputMode="decimal"
            required
            defaultValue={(jobCostCents / 100).toFixed(2)}
            error={state.fieldErrors?.amountDollars}
            hint="Lower this if only part of the repair is the tenant's. The notice they receive shows both numbers."
            idPrefix="chargeback"
          />

          <TextField
            label="Why this is the tenant's cost"
            name="reason"
            required
            error={state.fieldErrors?.reason}
            hint="Quoted back to the tenant word for word in their notice, and recorded on the audit trail. A sentence, not a word."
            idPrefix="chargeback"
          />

          <p className="text-muted-foreground text-sm">
            {evidenceCount > 0
              ? `${evidenceCount} ${
                  evidenceCount === 1 ? 'document or photo' : 'documents and photos'
                } on this job will be offered to the tenant as evidence.`
              : 'There are no photos or invoices on this job. A chargeback with no evidence is one you may not be able to defend.'}
          </p>

          <FieldError id="chargeback-error" message={state.error} />
          {/* Always in the tree, so the confirmation is a CHANGE to a region
              rather than a new node (R-101). */}
          <LiveRegion>
            {state.notice && <p className="text-sm">{state.notice}</p>}
          </LiveRegion>

          <button
            type="submit"
            disabled={pending}
            className={`${PRIMARY_BUTTON_CLASSES} self-start disabled:opacity-60`}
          >
            Post charge and serve notice
          </button>
        </form>
      )}
    </section>
  )
}
