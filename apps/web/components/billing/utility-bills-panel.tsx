'use client'

import { formatCents } from '@rental/core/money'
import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { FieldError } from '@/components/form/field.tsx'
import type { UtilityBillFormState } from '@/lib/billing/rubs-actions.ts'

// Recording a single-meter utility bill and charging it on (PAY-08, R-042).
//
// The split is SHOWN BEFORE it is charged, and charging is a second press.
// One press that records and bills would put four tenants' invoices at the
// mercy of a typo in an amount field, and a RUBS charge is the one a tenant
// is most likely to query.
//
// SUCCESS IS CONFIRMED BY THE RECORD, NOT A NOTICE. Charging a bill on
// replaces the button with the split itself — every share, the owner's
// portion, who pressed it and when — so the transient `useActionState` notice
// is unmounted before anybody reads it. That is the right way round here: a
// message that scrolls away is the wrong confirmation for the one action in
// this product that bills every tenant at a property at once. The FAILURE
// path keeps the form mounted, so a refusal still shows its reason.

export interface UtilityBillView {
  id: string
  utilityType: string
  utilityLabel: string
  provider: string | null
  periodStart: string
  periodEnd: string
  amountCents: number
  method: string
  allocatedAt: string | null
  allocatedByName: string | null
  landlordCents: number | null
  documentId: string | null
  shares: { id: string; unitName: string; amountCents: number; description: string }[]
}

export interface DocumentOption {
  id: string
  label: string
}

const METHOD_WORDS: Record<string, string> = {
  EQUAL: 'split equally',
  BEDROOMS: 'split by bedrooms',
  SQUARE_FEET: 'split by floor area',
}

const UTILITY_TYPES = [
  ['WATER', 'Water'],
  ['SEWER', 'Sewer'],
  ['ELECTRIC', 'Electricity'],
  ['GAS', 'Gas'],
  ['TRASH', 'Trash'],
  ['OTHER', 'Other'],
] as const

function SplitForm({
  bill,
  action,
}: {
  bill: UtilityBillView
  action: (state: UtilityBillFormState, formData: FormData) => Promise<UtilityBillFormState>
}) {
  const [state, formAction] = useActionState<UtilityBillFormState, FormData>(action, {})

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="utilityBillId" value={bill.id} />
      <FormAlerts state={state} />
      {!bill.documentId && (
        <p className="text-sm">
          No copy of the bill is attached. Upload it in this property’s documents
          and record the bill against it — the arithmetic on a tenant’s invoice
          is only half the defence.
        </p>
      )}
      <SubmitButton label={`Charge ${formatCents(bill.amountCents)} on to the tenants`} />
    </form>
  )
}

function RecordForm({
  action,
  documents,
}: {
  action: (state: UtilityBillFormState, formData: FormData) => Promise<UtilityBillFormState>
  documents: readonly DocumentOption[]
}) {
  const [state, formAction] = useActionState<UtilityBillFormState, FormData>(action, {})
  const errors = state.fieldErrors ?? {}

  return (
    <details open={Boolean(state.error)}>
      <summary className="min-h-11 cursor-pointer text-sm underline underline-offset-2">
        Record a bill
      </summary>

      {/* A real `<form action>`, working before hydration. */}
      <form action={formAction} className="flex flex-col gap-3 pt-3">
        <FormAlerts state={state} />

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="bill-type" className="text-sm font-medium">
              Utility
            </label>
            <select
              id="bill-type"
              name="utilityType"
              defaultValue="WATER"
              className="border-input focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              aria-describedby={errors.utilityType ? 'bill-type-error' : undefined}
            >
              {UTILITY_TYPES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <FieldError id="bill-type-error" message={errors.utilityType} />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="bill-provider" className="text-sm font-medium">
              Provider <span className="text-muted-foreground">(optional)</span>
            </label>
            <input
              id="bill-provider"
              name="provider"
              type="text"
              placeholder="City of Houston"
              className="border-input focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="bill-start" className="text-sm font-medium">
              Period from
            </label>
            <input
              id="bill-start"
              name="periodStart"
              type="date"
              required
              className="border-input focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              aria-describedby={errors.periodStart ? 'bill-start-error' : undefined}
            />
            <FieldError id="bill-start-error" message={errors.periodStart} />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="bill-end" className="text-sm font-medium">
              Period to
            </label>
            <input
              id="bill-end"
              name="periodEnd"
              type="date"
              required
              className="border-input focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              aria-describedby={errors.periodEnd ? 'bill-end-error' : 'bill-end-hint'}
            />
            <p id="bill-end-hint" className="text-muted-foreground text-xs">
              Both dates go on every tenant’s invoice line, and the charge is
              due on the day the period ended.
            </p>
            <FieldError id="bill-end-error" message={errors.periodEnd} />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="bill-amount" className="text-sm font-medium">
              Amount on the bill
            </label>
            <input
              id="bill-amount"
              name="amountDollars"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              placeholder="412.00"
              className="border-input focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              aria-describedby={errors.amountDollars ? 'bill-amount-error' : undefined}
            />
            <FieldError id="bill-amount-error" message={errors.amountDollars} />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="bill-method" className="text-sm font-medium">
              How is it split?
            </label>
            <select
              id="bill-method"
              name="method"
              defaultValue="EQUAL"
              className="border-input focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              aria-describedby={errors.method ? 'bill-method-error' : 'bill-method-hint'}
            >
              <option value="EQUAL">Equally between the units</option>
              <option value="BEDROOMS">By bedroom count</option>
              <option value="SQUARE_FEET">By floor area</option>
            </select>
            <p id="bill-method-hint" className="text-muted-foreground text-xs">
              Water usually tracks occupancy, heat tracks floor area. A unit
              missing the figure is refused rather than guessed at.
            </p>
            <FieldError id="bill-method-error" message={errors.method} />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="bill-document" className="text-sm font-medium">
            The bill itself
          </label>
          {/* Picks from this property's uploaded documents rather than being a
              second upload pipeline. R-012 already owns the compression,
              versioning, EXIF and soft-delete. */}
          <select
            id="bill-document"
            name="documentId"
            defaultValue=""
            className="border-input focus-visible:ring-ring rounded-md border px-2 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            aria-describedby="bill-document-hint"
          >
            <option value="">Not attached yet</option>
            {documents.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.label}
              </option>
            ))}
          </select>
          <p id="bill-document-hint" className="text-muted-foreground text-xs">
            Upload it in this property’s documents first. A share of a bill
            nobody can produce is a number the tenant has to take on trust.
          </p>
        </div>

        <SubmitButton label="Record this bill" />
      </form>
    </details>
  )
}

export function UtilityBillsPanel({
  bills,
  documents,
  canRecord,
  canSplit,
  rubsPermitted,
  state,
  record,
  split,
}: {
  bills: readonly UtilityBillView[]
  documents: readonly DocumentOption[]
  canRecord: boolean
  canSplit: boolean
  /// Null when no rule is configured for the state at all, which is a
  /// different sentence from "not permitted here".
  rubsPermitted: boolean | null
  state: string
  record: (
    formState: UtilityBillFormState,
    formData: FormData,
  ) => Promise<UtilityBillFormState>
  split: (
    formState: UtilityBillFormState,
    formData: FormData,
  ) => Promise<UtilityBillFormState>
}) {
  return (
    <section aria-labelledby="utility-bills" className="flex flex-col gap-4">
      <h2 id="utility-bills" className="text-lg font-semibold">
        Utility bills
      </h2>

      {/* Says the rule BEFORE somebody fills the form in, not after they
          press the button. D-4: the answer comes from the versioned rule. */}
      {rubsPermitted === null ? (
        <p className="rounded-md border p-3 text-sm">
          No jurisdiction rule is configured for {state}, so whether a bill may
          be split across units there is unknown. Add one before charging one
          on.
        </p>
      ) : !rubsPermitted ? (
        <p className="rounded-md border p-3 text-sm">
          {state} does not permit a utility bill to be split across units this
          way. Bills can still be recorded here for the property’s own books;
          they cannot be charged to tenants.
        </p>
      ) : null}

      {bills.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No bills recorded. This is for a property on one meter, where the
          bill is split across the units — a flat monthly fee written into a
          lease belongs on that lease instead.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {bills.map((bill) => (
            <li key={bill.id} className="flex flex-col gap-2 rounded-md border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {bill.utilityLabel}
                  {bill.provider ? ` · ${bill.provider}` : ''}
                </span>
                <span className="font-medium">{formatCents(bill.amountCents)}</span>
              </div>
              <p className="text-muted-foreground text-sm">
                {bill.periodStart} to {bill.periodEnd} ·{' '}
                {METHOD_WORDS[bill.method] ?? bill.method}
                {bill.documentId ? (
                  <>
                    {' · '}
                    <a
                      href={`/api/documents/${bill.documentId}/file`}
                      className="underline underline-offset-4"
                    >
                      the bill
                    </a>
                  </>
                ) : (
                  ' · no copy attached'
                )}
              </p>

              {bill.allocatedAt ? (
                <>
                  <ul className="flex flex-col gap-1 text-sm">
                    {bill.shares.map((share) => (
                      <li key={share.id} className="flex flex-col">
                        <span className="flex flex-wrap justify-between gap-2">
                          <span>{share.unitName}</span>
                          <span>{formatCents(share.amountCents)}</span>
                        </span>
                        {/* The arithmetic, as the tenant reads it. */}
                        <span className="text-muted-foreground text-xs">
                          {share.description}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {(bill.landlordCents ?? 0) > 0 && (
                    <p className="text-muted-foreground text-sm">
                      {formatCents(bill.landlordCents ?? 0)} stays with the owner —
                      the vacant units’ share, which is never spread across the
                      tenants.
                    </p>
                  )}
                  <p className="text-muted-foreground text-xs">
                    Charged on {bill.allocatedAt}
                    {bill.allocatedByName ? ` by ${bill.allocatedByName}` : ''}.
                  </p>
                </>
              ) : canSplit && rubsPermitted ? (
                <SplitForm bill={bill} action={split} />
              ) : (
                <p className="text-muted-foreground text-sm">Not charged on.</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {canRecord && <RecordForm action={record} documents={documents} />}
    </section>
  )
}
