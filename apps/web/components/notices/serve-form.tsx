'use client'

import { SERVICE_METHOD_LABELS, NOTICE_SERVICE_METHODS } from '@rental/core/notices'
import type { NoticeServiceMethodName } from '@rental/core/notices'
import { useActionState, useState } from 'react'
import { LiveRegion } from '@/components/auth-form.tsx'
import { FieldError } from '@/components/form/field.tsx'
import type { FormState } from '@/lib/notices/actions.ts'

// Recording one service event (COMM-02, R-051).
//
// ==========================================================================
// THE FORM ASKS FOR WHAT THE METHOD ACTUALLY PROVES, AND NOTHING ELSE.
//
// A posted notice needs a photograph; certified mail needs an article
// number; handing it to somebody needs neither. Showing all three fields
// always would make two of them look optional when one of them is the entire
// evidentiary value of the record - so the fields follow the method.
//
// The requirements are enforced on the SERVER and again by a CHECK constraint
// in the database. This is the affordance, not the guarantee: a form post
// that skips the client entirely still cannot create a POSTED_WITH_PHOTO row
// with no photograph.
// ==========================================================================

/// Which methods a state permits for this notice type, when it says. `null`
/// means unconfigured, and the form still offers everything - an owner in an
/// unconfigured state must still be able to record what they did.
export function ServeForm({
  action,
  permittedMethods,
  propertyTimezone,
  alreadyServed,
}: {
  action: (previous: FormState, formData: FormData) => Promise<FormState>
  permittedMethods: NoticeServiceMethodName[] | null
  propertyTimezone: string
  alreadyServed: boolean
}) {
  const [state, formAction, pending] = useActionState(action, {})
  const [method, setMethod] = useState<NoticeServiceMethodName>('PERSONAL')

  const needsPhoto = method === 'POSTED_WITH_PHOTO'
  const needsTracking = method === 'CERTIFIED_MAIL'
  const notPermitted = permittedMethods != null && !permittedMethods.includes(method)

  return (
    <form action={formAction} className="flex flex-col gap-4" encType="multipart/form-data">
      <LiveRegion assertive>
        {state.error && (
          <p className="rounded-md border border-red-300 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:text-red-400">
            {state.error}
          </p>
        )}
      </LiveRegion>
      {state.notice && (
        <p className="rounded-md border border-green-300 px-3 py-2 text-sm dark:border-green-900">
          {state.notice}
        </p>
      )}

      {alreadyServed && (
        <p className="text-muted-foreground text-sm">
          This notice has already been served once. Recording another method is
          normal — several states require a notice be both posted and mailed.
        </p>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="method" className="text-sm font-medium">
          How was it served?
        </label>
        <select
          id="method"
          name="method"
          value={method}
          onChange={(event) => setMethod(event.target.value as NoticeServiceMethodName)}
          className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
        >
          {NOTICE_SERVICE_METHODS.map((value) => (
            <option key={value} value={value}>
              {SERVICE_METHOD_LABELS[value]}
              {permittedMethods?.includes(value) ? ' ✓' : ''}
            </option>
          ))}
        </select>
        {notPermitted && (
          // A WARNING, NOT A REFUSAL. The rule may be out of date, the
          // service may already have happened, and a product that refuses to
          // record what an operator actually did produces no evidence at all
          // — which is worse than evidence carrying an honest flag.
          <p className="rounded-md border border-amber-300 px-3 py-2 text-sm dark:border-amber-900">
            This state&apos;s configured rules do not list that method for this
            notice type. You can still record it — it will be flagged as not
            permitted on the record.
          </p>
        )}
        {permittedMethods == null && (
          <p className="text-muted-foreground text-xs">
            No service rules are configured for this state, so nothing can be
            verified against them. The record will say so.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="servedAt" className="text-sm font-medium">
          When was it served?
        </label>
        <input
          id="servedAt"
          name="servedAt"
          type="datetime-local"
          required
          aria-describedby={state.fieldErrors?.servedAt ? 'servedAt-error' : undefined}
          className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
        <p className="text-muted-foreground text-xs">
          The property&apos;s local time ({propertyTimezone}).
        </p>
        <FieldError id="servedAt-error" message={state.fieldErrors?.servedAt} />
      </div>

      {needsPhoto && (
        <div className="flex flex-col gap-1">
          <label htmlFor="proof" className="text-sm font-medium">
            Photo of the posted notice
          </label>
          <input
            id="proof"
            name="proof"
            type="file"
            accept="image/*"
            required
            aria-describedby={state.fieldErrors?.proof ? 'proof-error' : undefined}
            className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          />
          <p className="text-muted-foreground text-xs">
            The photo&apos;s own timestamp is read from it and kept — a picture of
            a door proves nothing without when it was taken.
          </p>
          <FieldError id="proof-error" message={state.fieldErrors?.proof} />
        </div>
      )}

      {needsTracking && (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor="trackingNumber" className="text-sm font-medium">
              Certified-mail article number
            </label>
            <input
              id="trackingNumber"
              name="trackingNumber"
              type="text"
              required
              aria-describedby={
                state.fieldErrors?.trackingNumber ? 'trackingNumber-error' : undefined
              }
              className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
            />
            <FieldError id="trackingNumber-error" message={state.fieldErrors?.trackingNumber} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="carrier" className="text-sm font-medium">
              Carrier <span className="text-muted-foreground">(optional)</span>
            </label>
            <input
              id="carrier"
              name="carrier"
              type="text"
              placeholder="USPS"
              className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
            />
          </div>
        </>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="note" className="text-sm font-medium">
          Note <span className="text-muted-foreground">(optional)</span>
        </label>
        <textarea
          id="note"
          name="note"
          rows={2}
          placeholder="Taped to the inside of the main entry door."
          className="border-input focus-visible:ring-ring rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="bg-primary text-primary-foreground focus-visible:ring-ring min-h-11 rounded-md px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
      >
        {pending ? 'Recording…' : 'Record service'}
      </button>
    </form>
  )
}
