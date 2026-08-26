'use client'

import {
  DOCUMENTATION_ACCEPTED_LABELS,
  DOCUMENTATION_TYPES,
} from '@rental/core/confidential'
import { PAYMENT_ALLOCATION_CHARGE_TYPES } from '@rental/core/jurisdiction'
import { US_STATE_OPTIONS } from '@rental/core/property'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import {
  CheckboxField,
  FieldError,
  SelectField,
  TextField,
} from '@/components/form/field.tsx'
import type { FormState } from '@/lib/jurisdiction/actions.ts'

const LATE_FEE_TYPE_OPTIONS = [
  { value: 'NONE', label: 'No late fee' },
  { value: 'FLAT', label: 'Flat amount' },
  { value: 'PERCENT_OF_RENT', label: 'Percent of rent' },
  { value: 'DAILY', label: 'Daily amount' },
  { value: 'FLAT_PLUS_DAILY', label: 'Flat plus daily' },
]

const CHARGE_TYPE_LABELS: Record<string, string> = {
  RENT: 'Rent',
  RUBS_ALLOCATION: 'RUBS (utility allocation)',
  UTILITY: 'Utility',
  PET_RENT: 'Pet rent',
  PET_FEE: 'Pet fee',
  LATE_FEE: 'Late fee',
  NSF_FEE: 'NSF fee',
  LEGAL_COST: 'Legal cost',
  CHARGEBACK: 'Chargeback',
  OTHER: 'Other',
}

export interface RuleFormDefaults {
  state?: string
  jurisdiction?: string
  effectiveFrom?: string
  graceDays?: number | ''
  lateFeeType?: string
  lateFeeFlatDollars?: number | ''
  lateFeePercent?: number | ''
  lateFeeDailyDollars?: number | ''
  lateFeeMaxDollars?: number | ''
  lateFeeMaxPercent?: number | ''
  depositMaxPercent?: number | ''
  depositDispositionDays?: number | ''
  depositEscrowRequired?: boolean
  depositInterestRequired?: boolean
  preMoveOutWalkthroughRequired?: boolean | null
  preMoveOutWalkthroughDaysBefore?: number | ''
  entryNoticeHours?: number | ''
  payOrQuitDays?: number | ''
  noticeToVacateDays?: number | ''
  rentIncreaseNoticeDays?: number | ''
  rentIncreaseCapPercent?: number | ''
  retaliationWindowDays?: number | ''
  sourceOfIncomeProtected?: boolean | null
  earlyTerminationRightExists?: boolean | null
  earlyTerminationNoticeDays?: number | ''
  earlyTerminationDocumentationTypes?: readonly string[]
  justCauseRequired?: boolean
  paymentAllocationOrder?: readonly string[]
  applicationFeeCapDollars?: number | ''
  rubsPermitted?: boolean
  citation?: string
  reviewedBy?: string
  notes?: string
}

/**
 * One form for both "first version of a new (state, jurisdiction) config"
 * and "next version of an existing one" - createRuleVersion() figures out
 * which by looking up whatever is currently open-ended for the state and
 * jurisdiction submitted, so the form does not need to know which case it is
 * in.
 *
 * Payment-allocation order is a fixed checklist, not a reorderable list - see
 * PAYMENT_ALLOCATION_CHARGE_TYPES's own comment for why that is the smaller
 * thing that covers every footprint state today.
 */
export function RuleForm({
  action,
  submitLabel,
  defaults,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>
  submitLabel: string
  defaults: RuleFormDefaults
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}
  const checkedAllocations = new Set(
    defaults.paymentAllocationOrder ?? ['RENT', 'LATE_FEE'],
  )
  const acceptedDocumentation = new Set<string>(
    defaults.earlyTerminationDocumentationTypes ?? [],
  )

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-8">
      <FormAlerts state={state} />

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-semibold">Where and when</legend>
        <SelectField
          label="State"
          name="state"
          required
          defaultValue={defaults.state}
          error={errors.state}
          options={US_STATE_OPTIONS.map((s) => ({
            value: s.code,
            label: `${s.code} — ${s.name}`,
          }))}
        />
        <TextField
          label="City or county (optional)"
          name="jurisdiction"
          defaultValue={defaults.jurisdiction}
          error={errors.jurisdiction}
          hint="Leave blank for a statewide rule. A local ordinance is a full config of its own, not a diff against the state row."
        />
        <TextField
          label="Effective from"
          name="effectiveFrom"
          type="date"
          required
          defaultValue={defaults.effectiveFrom}
          error={errors.effectiveFrom}
          hint="Prospective only (D-4) - this cannot predate the version it replaces."
        />
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-semibold">Late fees (PAY-04)</legend>
        <TextField
          label="Grace days"
          name="graceDays"
          type="number"
          inputMode="numeric"
          min={0}
          max={60}
          required
          defaultValue={defaults.graceDays}
          error={errors.graceDays}
        />
        <SelectField
          label="Late-fee type"
          name="lateFeeType"
          required
          defaultValue={defaults.lateFeeType}
          error={errors.lateFeeType}
          options={LATE_FEE_TYPE_OPTIONS}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Flat fee ($)"
            name="lateFeeFlatDollars"
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            defaultValue={defaults.lateFeeFlatDollars}
            error={errors.lateFeeFlatCents}
          />
          <TextField
            label="Daily fee ($)"
            name="lateFeeDailyDollars"
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            defaultValue={defaults.lateFeeDailyDollars}
            error={errors.lateFeeDailyCents}
          />
          <TextField
            label="Percent of rent (%)"
            name="lateFeePercent"
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={0.1}
            defaultValue={defaults.lateFeePercent}
            error={errors.lateFeePercentBps}
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Cap ($, optional)"
            name="lateFeeMaxDollars"
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            defaultValue={defaults.lateFeeMaxDollars}
            error={errors.lateFeeMaxCents}
            hint="The statutory ceiling core clamps to (D-12)."
          />
          <TextField
            label="Cap (% of rent, optional)"
            name="lateFeeMaxPercent"
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={0.1}
            defaultValue={defaults.lateFeeMaxPercent}
            error={errors.lateFeeMaxPercentBps}
          />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-semibold">Deposits (PAY-07)</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Maximum (% of rent, optional)"
            name="depositMaxPercent"
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            defaultValue={defaults.depositMaxPercent}
            error={errors.depositMaxBps}
            hint="Leave blank where the state sets no statutory maximum."
          />
          <TextField
            label="Disposition deadline (days, optional)"
            name="depositDispositionDays"
            type="number"
            inputMode="numeric"
            min={0}
            max={180}
            defaultValue={defaults.depositDispositionDays}
            error={errors.depositDispositionDays}
          />
        </div>
        <CheckboxField
          label="Escrow account required"
          name="depositEscrowRequired"
          defaultChecked={defaults.depositEscrowRequired}
        />
        <CheckboxField
          label="Interest on deposit required"
          name="depositInterestRequired"
          defaultChecked={defaults.depositInterestRequired}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-semibold">
          Move-out walkthrough (INSP-02)
        </legend>
        <div className="flex flex-col gap-1.5">
          <SelectField
            label="Pre-move-out walkthrough right"
            name="preMoveOutWalkthroughRequired"
            idPrefix="rule"
            defaultValue={
              defaults.preMoveOutWalkthroughRequired == null
                ? ''
                : String(defaults.preMoveOutWalkthroughRequired)
            }
            error={errors.preMoveOutWalkthroughRequired}
            placeholder="Not reviewed"
            options={[
              { value: 'true', label: 'Yes, granted' },
              { value: 'false', label: 'No' },
            ]}
          />
          <p className="text-muted-foreground text-sm">
            Whether this state grants tenants a pre-move-out inspection right. Left unreviewed, no
            walkthrough is ever auto-scheduled for this state rather than guessing.
          </p>
        </div>
        <TextField
          label="Days before move-out (optional)"
          name="preMoveOutWalkthroughDaysBefore"
          type="number"
          inputMode="numeric"
          min={0}
          max={180}
          defaultValue={defaults.preMoveOutWalkthroughDaysBefore}
          error={errors.preMoveOutWalkthroughDaysBefore}
          hint="Only used when the right above is granted."
        />
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-semibold">
          Entry and notices (MAINT-05, LEASE-09)
        </legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Entry-notice hours (optional)"
            name="entryNoticeHours"
            type="number"
            inputMode="numeric"
            min={0}
            max={168}
            defaultValue={defaults.entryNoticeHours}
            error={errors.entryNoticeHours}
          />
          <TextField
            label="Pay-or-quit days (optional)"
            name="payOrQuitDays"
            type="number"
            inputMode="numeric"
            min={0}
            max={365}
            defaultValue={defaults.payOrQuitDays}
            error={errors.payOrQuitDays}
          />
          <TextField
            label="Notice-to-vacate days (optional)"
            name="noticeToVacateDays"
            type="number"
            inputMode="numeric"
            min={0}
            max={365}
            defaultValue={defaults.noticeToVacateDays}
            error={errors.noticeToVacateDays}
          />
          <TextField
            label="Rent-increase notice days (optional)"
            name="rentIncreaseNoticeDays"
            type="number"
            inputMode="numeric"
            min={0}
            max={365}
            defaultValue={defaults.rentIncreaseNoticeDays}
            error={errors.rentIncreaseNoticeDays}
          />
          <TextField
            label="Rent-increase cap (% of current rent, optional)"
            name="rentIncreaseCapPercent"
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            defaultValue={defaults.rentIncreaseCapPercent}
            error={errors.rentIncreaseCapPercentBps}
            hint="Leave blank where the state sets no statutory ceiling on a renewal's rent increase (LEASE-09)."
          />
          <TextField
            label="Retaliation-presumption window, days (optional)"
            name="retaliationWindowDays"
            type="number"
            inputMode="numeric"
            min={0}
            max={365}
            defaultValue={defaults.retaliationWindowDays}
            error={errors.retaliationWindowDays}
            hint="Commonly ~180 (six months). Left blank, the retaliation guard (RISK-06) stays silent for this state rather than assuming a number."
          />
        </div>
        <CheckboxField
          label="Just-cause eviction required"
          name="justCauseRequired"
          defaultChecked={defaults.justCauseRequired}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-semibold">
          Payments and applications (PAY-03, LEASE-03)
        </legend>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">
            Payment allocation order
          </span>
          <p className="text-muted-foreground text-sm">
            Which charge types a partial payment pays down, in this order.
          </p>
          <FieldError
            id="field-payment-allocation-order-error"
            message={errors.paymentAllocationOrder}
          />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PAYMENT_ALLOCATION_CHARGE_TYPES.map((chargeType) => (
              <CheckboxField
                key={chargeType}
                label={CHARGE_TYPE_LABELS[chargeType] ?? chargeType}
                name="paymentAllocationOrder"
                value={chargeType}
                defaultChecked={checkedAllocations.has(chargeType)}
              />
            ))}
          </div>
        </div>
        <TextField
          label="Application-fee cap ($, optional)"
          name="applicationFeeCapDollars"
          type="number"
          inputMode="decimal"
          min={0}
          step={1}
          defaultValue={defaults.applicationFeeCapDollars}
          error={errors.applicationFeeCapCents}
        />
        <CheckboxField
          label="RUBS billing permitted"
          name="rubsPermitted"
          defaultChecked={defaults.rubsPermitted ?? true}
        />
        <div className="flex flex-col gap-1.5">
          <SelectField
            label="Source-of-income protected class (LEASE-01)"
            name="sourceOfIncomeProtected"
            idPrefix="rule"
            defaultValue={
              defaults.sourceOfIncomeProtected == null
                ? ''
                : String(defaults.sourceOfIncomeProtected)
            }
            error={errors.sourceOfIncomeProtected}
            placeholder="Not reviewed"
            options={[
              { value: 'true', label: 'Yes, protected' },
              { value: 'false', label: 'No' },
            ]}
          />
          <p className="text-muted-foreground text-sm">
            Whether this state treats housing vouchers / source of income as protected. Left
            unreviewed, a published listing&rsquo;s disclosure says so honestly rather than
            guessing.
          </p>
        </div>
      </fieldset>

      {/* R-091b. State law, unlike R-085's SCRA (D-82) — which is exactly why
          it is here and §3955 is not. Three-valued, so "nobody has looked at
          this state" stays distinguishable from "this state grants no such
          right": one is a five-minute edit on this form, the other is a legal
          conclusion, and getting them the wrong way round refuses somebody a
          statutory right. */}
      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-semibold">
          Early termination on a safety ground (RISK-04)
        </legend>
        <div className="flex flex-col gap-1.5">
          <SelectField
            label="Statutory early-termination right"
            name="earlyTerminationRightExists"
            idPrefix="rule"
            defaultValue={
              defaults.earlyTerminationRightExists == null
                ? ''
                : String(defaults.earlyTerminationRightExists)
            }
            error={errors.earlyTerminationRightExists}
            placeholder="Not reviewed"
            options={[
              { value: 'true', label: 'Yes, granted' },
              { value: 'false', label: 'No' },
            ]}
          />
          <p className="text-muted-foreground text-sm">
            Whether this state lets a tenant end a tenancy early, without penalty, on a
            statutory safety ground. Left unreviewed, the product says so rather than
            answering for the state either way.
          </p>
        </div>
        <TextField
          label="Days of notice the early-termination right requires"
          name="earlyTerminationNoticeDays"
          type="number"
          inputMode="numeric"
          min={0}
          max={180}
          defaultValue={defaults.earlyTerminationNoticeDays}
          error={errors.earlyTerminationNoticeDays}
          hint="Counted in calendar days from the day the tenant delivers notice. Only used where the right above is granted."
        />
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Documentation this state accepts</span>
          <p className="text-muted-foreground text-sm">
            Leaving all of these unticked does not mean the state accepts none — it means
            nobody has itemised them, and any class actually recorded will be taken.
          </p>
          <FieldError
            id="field-early-termination-documentation-types-error"
            message={errors.earlyTerminationDocumentationTypes}
          />
          <div className="flex flex-col gap-2">
            {DOCUMENTATION_TYPES.map((documentationType) => (
              <CheckboxField
                key={documentationType}
                label={DOCUMENTATION_ACCEPTED_LABELS[documentationType]}
                name="earlyTerminationDocumentationTypes"
                value={documentationType}
                defaultChecked={acceptedDocumentation.has(documentationType)}
              />
            ))}
          </div>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-semibold">Review</legend>
        <TextField
          label="Citation"
          name="citation"
          defaultValue={defaults.citation}
          error={errors.citation}
          hint="Statute or ordinance reference."
        />
        <TextField
          label="Reviewed by"
          name="reviewedBy"
          defaultValue={defaults.reviewedBy}
          error={errors.reviewedBy}
          hint="Left blank means an attorney has not signed off on this version yet - a real gate, not a formality."
        />
        <TextField
          label="Notes"
          name="notes"
          defaultValue={defaults.notes}
          error={errors.notes}
        />
      </fieldset>

      <SubmitButton label={submitLabel} />
    </form>
  )
}

// paymentAllocationOrder as this file's own value keeps the submitted order
// aligned with PAYMENT_ALLOCATION_CHARGE_TYPES regardless of DOM checkbox
// order - see createRuleVersion, which reads formData.getAll in submission
// order. Rendering the checkboxes in that same fixed order (above) is what
// keeps the two in sync without the action having to re-sort anything.
