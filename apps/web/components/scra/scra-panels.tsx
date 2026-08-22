'use client'

import {
  SCRA_BASIS_EVIDENCE,
  SCRA_BASIS_LABELS,
  SCRA_LOOKUP_RESULTS,
  SCRA_LOOKUP_RESULT_LABELS,
  SCRA_TERMINATION_BASES,
  type ScraLookupResult,
  type ScraTerminationBasis,
} from '@rental/core/scra'
import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { FieldError, SelectField, TextField } from '@/components/form/field.tsx'
import type { ScraFormState } from '@/lib/scra/actions.ts'

// The SCRA surfaces (RISK-12, R-085).
//
// Two panels with nothing in common but the statute: recording a DMDC search
// (§3931's affidavit), and ending a tenancy on military orders (§3955).

type Action = (state: ScraFormState, formData: FormData) => Promise<ScraFormState>

export interface LookupRow {
  id: string
  tenantName: string
  result: ScraLookupResult
  searchedOn: string
  providerReference: string | null
  activeDutyStartOn: string | null
  activeDutyEndOn: string | null
  certificateDocumentId: string | null
  certificateFileName: string | null
  recordedByName: string
  notes: string | null
}

const RESULT_TONE: Record<ScraLookupResult, string> = {
  in_service:
    'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
  not_in_service:
    'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100',
  // Deliberately NOT green. A no-match reads as "nothing found", which is the
  // exact misreading that gets a false affidavit signed.
  indeterminate:
    'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
}

function RecordLookupForm({
  action,
  tenants,
  evictionCaseId,
}: {
  action: Action
  tenants: readonly { id: string; name: string }[]
  evictionCaseId?: string
}) {
  const [state, formAction] = useActionState<ScraFormState, FormData>(action, {})
  const [result, setResult] = useState<ScraLookupResult | ''>('')
  const errors = state.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {evictionCaseId && <input type="hidden" name="evictionCaseId" value={evictionCaseId} />}

      <SelectField
        label="Who was searched for"
        name="tenantId"
        required
        idPrefix="scra-lookup"
        error={errors.tenantId}
        options={tenants.map((tenant) => ({ value: tenant.id, label: tenant.name }))}
        placeholder="Pick the person…"
      />

      <TextField
        label="Date the search was run"
        name="searchedOn"
        type="date"
        required
        idPrefix="scra-lookup"
        error={errors.searchedOn}
        hint="The date on the certificate, not today's date."
      />

      <SelectField
        label="What the certificate says"
        name="result"
        required
        idPrefix="scra-lookup"
        error={errors.result}
        options={SCRA_LOOKUP_RESULTS.map((value) => ({
          value,
          label: SCRA_LOOKUP_RESULT_LABELS[value],
        }))}
        onChange={(event) => setResult(event.target.value as ScraLookupResult)}
      />

      {result === 'in_service' && (
        <>
          <p className="rounded-md border border-amber-500 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-50">
            Recording this places an SCRA hold on the tenancy automatically —
            no late fees, no chase, no access changes, and a banner on every
            notice screen.
          </p>
          <TextField
            label="Active duty began"
            name="activeDutyStartOn"
            type="date"
            idPrefix="scra-lookup"
            hint="If the certificate states it."
          />
          <TextField
            label="Active duty ends"
            name="activeDutyEndOn"
            type="date"
            idPrefix="scra-lookup"
          />
        </>
      )}

      {result === 'indeterminate' && (
        <p className="rounded-md border border-amber-500 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-50">
          A no-match is not a negative. It will not support the §3931
          affidavit — re-run the search with a date of birth or SSN.
        </p>
      )}

      <TextField
        label="Certificate reference"
        name="providerReference"
        idPrefix="scra-lookup"
        hint="Whatever identifier DMDC printed on it."
      />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="scra-certificate" className="text-sm font-medium">
          The certificate itself
        </label>
        <input
          id="scra-certificate"
          name="certificate"
          type="file"
          accept="application/pdf,image/*"
          className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
        <p className="text-muted-foreground text-xs">
          The signed PDF from scra.dmdc.osd.mil. A search with no certificate
          behind it is a claim, not evidence.
        </p>
        <FieldError id="scra-certificate-error" message={errors.certificate} />
      </div>

      <TextField label="Notes" name="notes" idPrefix="scra-lookup" />

      <FormAlerts state={state} />
      <SubmitButton label="Record this search" />
    </form>
  )
}

export function ScraLookupsPanel({
  lookups,
  tenants,
  canRecord,
  recordAction,
  evictionCaseId,
  /// Rendered above the form when the caller knows something the panel does
  /// not — the eviction page's own "this judgment needs one" prompt.
  prompt,
}: {
  lookups: readonly LookupRow[]
  tenants: readonly { id: string; name: string }[]
  canRecord: boolean
  recordAction: Action
  evictionCaseId?: string
  prompt?: string
}) {
  return (
    <section aria-labelledby="scra-lookups" className="flex flex-col gap-4 border-t pt-4">
      <h2 id="scra-lookups" className="text-lg font-semibold">
        Military-service searches
      </h2>

      <p className="text-muted-foreground text-sm">
        A default judgment needs an affidavit stating whether the tenant is on
        active duty (50 U.S.C. §3931), and the affidavit needs a DMDC search
        behind it. Run it at{' '}
        {/* A real link, not a button: it goes somewhere else entirely, and
            the whole point is that this product does not run the search. */}
        <a
          href="https://scra.dmdc.osd.mil/"
          className="underline underline-offset-2"
          rel="noreferrer noopener"
          target="_blank"
        >
          scra.dmdc.osd.mil
        </a>
        , then record what it said here. Nothing in this product performs the
        search.
      </p>

      {prompt && (
        <p className="rounded-md border border-amber-500 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-50">
          {prompt}
        </p>
      )}

      {lookups.length === 0 ? (
        <p className="text-muted-foreground text-sm">No search has been recorded here.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {lookups.map((lookup) => (
            <li key={lookup.id} className="flex flex-col gap-1 px-4 py-3">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{lookup.tenantName}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${RESULT_TONE[lookup.result]}`}
                >
                  {SCRA_LOOKUP_RESULT_LABELS[lookup.result]}
                </span>
              </span>
              <span className="text-muted-foreground text-sm">
                Searched {lookup.searchedOn} · recorded by {lookup.recordedByName}
                {lookup.providerReference && ` · ${lookup.providerReference}`}
              </span>
              {(lookup.activeDutyStartOn || lookup.activeDutyEndOn) && (
                <span className="text-muted-foreground text-sm">
                  Active duty {lookup.activeDutyStartOn ?? 'unstated'} to{' '}
                  {lookup.activeDutyEndOn ?? 'unstated'}
                </span>
              )}
              <span className="text-sm">
                {lookup.certificateDocumentId ? (
                  <a
                    href={`/api/documents/${lookup.certificateDocumentId}/file`}
                    className="underline underline-offset-2"
                  >
                    {lookup.certificateFileName}
                  </a>
                ) : (
                  <span className="text-amber-800 dark:text-amber-300">
                    No certificate attached — this is a claim, not evidence.
                  </span>
                )}
              </span>
              {lookup.notes && <span className="text-muted-foreground text-sm">{lookup.notes}</span>}
            </li>
          ))}
        </ul>
      )}

      {canRecord && tenants.length > 0 && (
        <RecordLookupForm
          action={recordAction}
          tenants={tenants}
          evictionCaseId={evictionCaseId}
        />
      )}
    </section>
  )
}

export function ScraTerminationPanel({
  action,
  canRecord,
  /// Set once a termination has been recorded — the panel then reports it
  /// rather than offering the form again.
  recorded,
}: {
  action: Action
  canRecord: boolean
  recorded: { basis: ScraTerminationBasis; effectiveOn: string } | null
}) {
  const [state, formAction] = useActionState<ScraFormState, FormData>(action, {})
  const [basis, setBasis] = useState<ScraTerminationBasis | ''>('')
  const errors = state.fieldErrors ?? {}

  return (
    <section aria-labelledby="scra-termination" className="flex flex-col gap-3 border-t pt-4">
      <h2 id="scra-termination" className="text-lg font-semibold">
        Termination on military orders
      </h2>

      {recorded ? (
        <p className="text-sm">
          Terminated under {SCRA_BASIS_LABELS[recorded.basis]}. The tenancy ends{' '}
          {recorded.effectiveOn}.
        </p>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            SCRA §3955 lets a servicemember end a residential lease on orders.
            The date is fixed by federal law — 30 days after the next rent due
            date following delivery of the notice and orders — and it
            overrides this state&rsquo;s notice period rather than being
            measured against it.
          </p>

          {canRecord && (
            <form action={formAction} className="flex flex-col gap-3">
              <SelectField
                label="Which limb of §3955(b)"
                name="basis"
                required
                idPrefix="scra-term"
                error={errors.basis}
                options={SCRA_TERMINATION_BASES.map((value) => ({
                  value,
                  label: SCRA_BASIS_LABELS[value],
                }))}
                onChange={(event) => setBasis(event.target.value as ScraTerminationBasis)}
              />

              {basis && (
                <p className="text-muted-foreground text-sm">{SCRA_BASIS_EVIDENCE[basis]}</p>
              )}

              <TextField
                label="Date the notice and orders were delivered"
                name="deliveredOn"
                type="date"
                required
                idPrefix="scra-term"
                error={errors.deliveredOn}
                hint="The effective date is computed from this — do not type an end date."
              />

              <div className="flex flex-col gap-1.5">
                <label htmlFor="scra-orders" className="text-sm font-medium">
                  The orders <span aria-hidden="true">*</span>
                </label>
                <input
                  id="scra-orders"
                  name="orders"
                  type="file"
                  accept="application/pdf,image/*"
                  required
                  className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
                />
                <p className="text-muted-foreground text-xs">
                  §3955(c)(1) requires the notice to be accompanied by a copy
                  of them.
                </p>
                <FieldError id="scra-orders-error" message={errors.orders} />
              </div>

              {/* NOT "Forwarding address", which is what the notice panel
                  further down this same page calls its own copy of this
                  field. Two inputs with one label is a strict-mode
                  ambiguity in a test and, more to the point, a screen
                  reader announcing the same name twice with nothing to tell
                  them apart. The longer label is also the truer one. */}
              <TextField
                label="Where to send the deposit disposition"
                name="forwardingAddress"
                idPrefix="scra-term"
                hint="They may be posted out before the deadline falls due."
              />

              <FormAlerts state={state} />
              <SubmitButton label="Record the termination" />
            </form>
          )}
        </>
      )}
    </section>
  )
}
