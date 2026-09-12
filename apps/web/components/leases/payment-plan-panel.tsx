'use client'

import { formatCents } from '@rental/core/money'
import { MAX_PLAN_INSTALMENTS, PLAN_GRACE_DAYS } from '@rental/core/payments'
import { friendlyBusinessDate } from '@rental/core/scheduling'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { PlanFormState } from '@/lib/payments/plan-actions.ts'

// Repayment plans on one tenancy (PAY-08, PAY-12; R-175).
//
// ==========================================================================
// THE PANEL SHOWS ENDED PLANS AS WELL AS THE LIVE ONE, and that is not
// completeness for its own sake. "We offered them a plan in March and they
// broke it in May" is the whole content of the next conversation about this
// tenancy — and it is also the fact a retaliation or disparate-treatment
// claim is argued from in both directions. A screen showing only what is on
// today cannot say it.
// ==========================================================================
//
// Everything here takes RAW `BusinessDate`s and formats them in the render
// (D-154). A pre-formatted prop turns `friendlyBusinessDate` from a guardrail
// into a crash, because it throws on anything that is not `YYYY-MM-DD`.

export interface PlanInstalmentRow {
  id: string
  sequence: number
  dueOn: string
  amountCents: number
}

/// R-203: where the plan's own e-signature got to, or null when nobody has
/// been asked. NULL IS THE ORDINARY CASE AND MUST READ AS ONE — the signature
/// is the operator's choice per plan and never a condition of the hold
/// (D-214), so an unsigned plan is a complete plan and the panel must not
/// dress it up as an outstanding task.
export interface PlanSignatureRow {
  status: 'DRAFT' | 'SENT' | 'PARTIALLY_SIGNED' | 'COMPLETED' | 'VOIDED'
  signedCount: number
  signerCount: number
  signerNames: string[]
  /// The executed PDF, once everybody has signed.
  executedDocumentId: string | null
}

export interface PlanRow {
  id: string
  status: 'ACTIVE' | 'COMPLETED' | 'BROKEN' | 'CANCELLED'
  arrearsCents: number
  startedOn: string
  note: string
  instalments: PlanInstalmentRow[]
  paidCents: number
  remainingCents: number
  shortfallCents: number
  nextDueOn: string | null
  missedDueOn: string | null
  brokenOn: string | null
  /// A real timestamp, already read in the property's zone by the page.
  agreedOn: string
  agreedByName: string
  cancelReason: string | null
  signature: PlanSignatureRow | null
}

const STATUS_LABEL: Record<PlanRow['status'], string> = {
  ACTIVE: 'In force',
  COMPLETED: 'Paid in full',
  BROKEN: 'Broken',
  CANCELLED: 'Cancelled',
}

function Schedule({ plan }: { plan: PlanRow }) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">
        The instalments agreed on the plan of {friendlyBusinessDate(plan.startedOn)}: when each
        one falls due and how much it is.
      </caption>
      <thead>
        <tr className="text-muted-foreground text-left text-xs">
          <th scope="col" className="py-1 pr-3 font-medium">
            Instalment
          </th>
          <th scope="col" className="py-1 pr-3 font-medium">
            Falls due
          </th>
          <th scope="col" className="py-1 text-right font-medium">
            Instalment amount
          </th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {plan.instalments.map((instalment) => (
          <tr key={instalment.id}>
            <td className="py-1.5 pr-3">
              {instalment.sequence} of {plan.instalments.length}
            </td>
            <td className="py-1.5 pr-3">{friendlyBusinessDate(instalment.dueOn)}</td>
            <td className="py-1.5 text-right tabular-nums">
              {formatCents(instalment.amountCents)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function SignatureBlock({
  plan,
  leaseId,
  canManage,
  formAction,
}: {
  plan: PlanRow
  leaseId: string
  canManage: boolean
  formAction: (formData: FormData) => void
}) {
  const signature = plan.signature

  if (signature && signature.status === 'COMPLETED') {
    return (
      <p className="text-sm">
        Signed by {signature.signerNames.join(', ')}.{' '}
        {signature.executedDocumentId && (
          <a
            href={`/api/documents/${signature.executedDocumentId}/file`}
            className="underline underline-offset-4"
          >
            Read the signed agreement
          </a>
        )}
      </p>
    )
  }

  if (signature && (signature.status === 'SENT' || signature.status === 'PARTIALLY_SIGNED')) {
    return (
      <p className="text-muted-foreground text-sm">
        Out for signature — {signature.signedCount} of {signature.signerNames.length} signed.
        The plan is in force either way.
      </p>
    )
  }

  if (!canManage) return null

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="planId" value={plan.id} />
      <input type="hidden" name="leaseId" value={leaseId} />
      <p className="text-muted-foreground text-sm">
        {signature?.status === 'VOIDED'
          ? 'The earlier signing request was withdrawn. Nothing is out for signature.'
          : 'Nobody has been asked to sign this plan. It is in force either way — a signature records that the tenant agreed to these terms, which is what a broken plan is argued from.'}
      </p>
      <SubmitButton label="Send this plan for signature" />
    </form>
  )
}

function CancelForm({
  plan,
  formAction,
}: {
  plan: PlanRow
  formAction: (formData: FormData) => void
}) {
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="planId" value={plan.id} />
      <TextField
        label="Why this plan is ending (required)"
        name="cancelReason"
        required
        hint="Collection and late fees resume from the moment this is saved, against somebody who was told they had an arrangement. This is what answers “on what basis”."
        idPrefix={`cancel-plan-${plan.id}`}
      />
      <SubmitButton label="End this repayment plan" />
    </form>
  )
}

function AgreeForm({
  leaseId,
  balanceCents,
  state,
  formAction,
}: {
  leaseId: string
  balanceCents: number
  state: PlanFormState
  formAction: (formData: FormData) => void
}) {
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="leaseId" value={leaseId} />

      <TextField
        label="Amount the plan repays (dollars)"
        name="totalDollars"
        type="number"
        inputMode="decimal"
        min={0.01}
        step="0.01"
        required
        // PREFILLED FROM THE BALANCE, NOT FORCED TO IT. An operator can and
        // often does agree a plan over part of a debt - the arrears without
        // this month's rent, say - so the balance is the starting point and
        // not the answer.
        defaultValue={balanceCents > 0 ? (balanceCents / 100).toFixed(2) : undefined}
        hint="What this plan covers. It does not have to be the whole balance."
        error={state.fieldErrors?.totalDollars}
        idPrefix="agree-plan"
      />

      <TextField
        label="Number of instalments"
        name="instalments"
        type="number"
        inputMode="numeric"
        min={1}
        max={MAX_PLAN_INSTALMENTS}
        step={1}
        required
        defaultValue={3}
        hint="Monthly, split evenly. The odd cents land on the earliest instalments."
        error={state.fieldErrors?.instalments}
        idPrefix="agree-plan"
      />

      <TextField
        label="First instalment due on"
        name="firstDueOn"
        // A native date input, not a picker library — and it takes a raw
        // `YYYY-MM-DD`, which is the one place a business date is written
        // out unformatted on purpose.
        type="date"
        required
        error={state.fieldErrors?.firstDueOn}
        idPrefix="agree-plan"
      />

      <TextField
        label="What was agreed, in words (required)"
        name="note"
        required
        hint="What the tenant actually said they could do — “she starts the new job on the 14th”. The schedule records the dates; this records why they are those dates."
        error={state.fieldErrors?.note}
        idPrefix="agree-plan"
      />

      <SubmitButton label="Agree this repayment plan" />
    </form>
  )
}

export function PaymentPlanPanel({
  leaseId,
  plans,
  balanceCents,
  canManage,
  agreeAction,
  cancelAction,
  sendAction,
}: {
  leaseId: string
  plans: readonly PlanRow[]
  balanceCents: number
  /// False for somebody who can read the lease but may not stop its
  /// collection. The panel still lists the plans — that a tenancy is on one
  /// is operationally important to anyone reading it — and offers no
  /// controls. The same posture `HoldsPanel` takes.
  canManage: boolean
  agreeAction: (state: PlanFormState, formData: FormData) => Promise<PlanFormState>
  cancelAction: (state: PlanFormState, formData: FormData) => Promise<PlanFormState>
  sendAction: (state: PlanFormState, formData: FormData) => Promise<PlanFormState>
}) {
  const live = plans.find((plan) => plan.status === 'ACTIVE') ?? null
  const ended = plans.filter((plan) => plan.status !== 'ACTIVE')

  // ==========================================================================
  // BOTH ACTIONS' STATE LIVES UP HERE, AND THEIR ALERTS RENDER OUTSIDE THE
  // CONDITIONAL BELOW.
  //
  // Each of these presses changes which half of that conditional exists.
  // Agreeing a plan replaces the agree form with the live-plan block; ending
  // one does the reverse. A `FormAlerts` inside either form is therefore
  // destroyed by the very response it is meant to display, and the press
  // appears to do nothing at all - R-044's chase panel and R-086's
  // self-replacing panel are the same trap from both directions. `aria-live`
  // needs the region mounted BEFORE the text lands in it anyway.
  // ==========================================================================
  const [agreeState, agreeFormAction] = useActionState<PlanFormState, FormData>(agreeAction, {})
  const [cancelState, cancelFormAction] = useActionState<PlanFormState, FormData>(cancelAction, {})
  // Its own state, alongside the other two and for the same reason: pressing
  // it replaces the form that produced it with the "out for signature" line.
  const [sendState, sendFormAction] = useActionState<PlanFormState, FormData>(sendAction, {})

  return (
    <section aria-labelledby="repayment-plan" className="flex flex-col gap-4 border-t pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="repayment-plan" className="text-lg font-semibold">
          Repayment plan
        </h2>
        {live && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
            {live.shortfallCents > 0 ? 'Behind schedule' : 'In force'}
          </span>
        )}
      </div>

      {canManage && (
        <div>
          <FormAlerts state={agreeState} />
          <FormAlerts state={cancelState} />
          <FormAlerts state={sendState} />
        </div>
      )}

      <p className="text-muted-foreground text-sm">
        An agreement to clear arrears over time. While one is in force the
        chase and the late-fee meter are both off — and an instalment that goes{' '}
        {PLAN_GRACE_DAYS} days past its date without the money arriving breaks
        the plan, lifts that pause and raises a task, without anybody having to
        remember to look.
      </p>

      {live ? (
        <div className="flex flex-col gap-3 rounded-md border p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">
              {formatCents(live.remainingCents)} of {formatCents(live.arrearsCents)} still to pay
            </span>
            <span className="text-muted-foreground text-sm">
              Agreed {live.agreedOn} by {live.agreedByName}
            </span>
          </div>

          <p className="text-muted-foreground text-sm">“{live.note}”</p>

          {/* The one sentence somebody opens this panel for. Behind-schedule
              first, because a plan quietly falling apart is the state this
              whole item exists to make visible. */}
          <p className="text-sm">
            {live.shortfallCents > 0 ? (
              <>
                {formatCents(live.shortfallCents)} short of what the schedule expected by now.
                The plan breaks once the instalment due{' '}
                {live.missedDueOn ? friendlyBusinessDate(live.missedDueOn) : 'next'} is more
                than {PLAN_GRACE_DAYS} days past.
              </>
            ) : live.nextDueOn ? (
              <>Keeping to it. Next instalment {friendlyBusinessDate(live.nextDueOn)}.</>
            ) : (
              <>Paid in full — the plan closes on tonight&rsquo;s sweep.</>
            )}
          </p>

          <Schedule plan={live} />

          <SignatureBlock
            plan={live}
            leaseId={leaseId}
            canManage={canManage}
            formAction={sendFormAction}
          />

          {canManage && <CancelForm plan={live} formAction={cancelFormAction} />}
        </div>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            No plan is in force on this tenancy.
          </p>
          {canManage && (
            <AgreeForm
              leaseId={leaseId}
              balanceCents={balanceCents}
              state={agreeState}
              formAction={agreeFormAction}
            />
          )}
        </>
      )}


      {ended.length > 0 && (
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">
            {ended.length} earlier {ended.length === 1 ? 'plan' : 'plans'}
          </summary>
          <ul className="text-muted-foreground mt-2 flex flex-col gap-2">
            {ended.map((plan) => (
              <li key={plan.id}>
                {STATUS_LABEL[plan.status]} — {formatCents(plan.arrearsCents)} over{' '}
                {plan.instalments.length}{' '}
                {plan.instalments.length === 1 ? 'instalment' : 'instalments'}, agreed{' '}
                {plan.agreedOn} by {plan.agreedByName} (“{plan.note}”)
                {plan.brokenOn && (
                  <> — broken on the instalment due {friendlyBusinessDate(plan.brokenOn)}</>
                )}
                {plan.cancelReason && <> — ended: “{plan.cancelReason}”</>}
                {plan.signature?.status === 'COMPLETED' && (
                  <>
                    {' — '}
                    {plan.signature.executedDocumentId ? (
                      <a
                        href={`/api/documents/${plan.signature.executedDocumentId}/file`}
                        className="underline underline-offset-4"
                      >
                        signed by {plan.signature.signerNames.join(', ')}
                      </a>
                    ) : (
                      <>signed by {plan.signature.signerNames.join(', ')}</>
                    )}
                  </>
                )}
                {/* THE RECORD SAYS PAID IN FULL AND THE LEDGER CANNOT SUPPORT
                    IT (R-187). Until this was fixed, ordinary rent counted as
                    instalment money, so a tenancy paying nothing extra
                    completed its own plan. Nothing is backfilled — a status
                    rewritten months later is a worse record than a true one
                    with the doubt written beside it — so the panel says so
                    where the plan is actually read from. */}
                {plan.status === 'COMPLETED' && plan.remainingCents > 0 && (
                  <strong className="text-destructive block font-medium">
                    Recorded as paid in full, but {formatCents(plan.remainingCents)} of the
                    schedule had not reached the ledger when it closed. Check the statement
                    before relying on this as proof the arrears were cleared.
                  </strong>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
