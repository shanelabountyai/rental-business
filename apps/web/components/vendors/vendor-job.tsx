'use client'

import { useActionState, useState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { TextField } from '@/components/form/field.tsx'
import type { VendorFormState } from '@/lib/vendors/actions.ts'

// The vendor's whole surface (D-6, MAINT-03, R-025). One screen, no account,
// no navigation - a plumber holding a phone in a driveway.
//
// Written mobile-first and deliberately plain: large targets, no jargon, and
// nothing that looks like a portal to sign into, because the operator
// interview D-6 rests on was unambiguous that a vendor with five landlord
// clients will not learn a sixth.

export interface VendorJobProps {
  job: {
    scope: string
    priority: string
    propertyName: string
    address: string
    unitName: string
    tenantFirstName: string | null
    tenantPhone: string | null
    ticketDescription: string | null
    vendorResponse: string | null
    status: string
    proposedStart: string | null
    proposedEnd: string | null
    invoiceUploaded: boolean
  }
  photos: readonly { id: string; fileName: string; href: string }[]
  appliances: readonly {
    id: string
    category: string
    make: string | null
    model: string | null
    serialNumber: string | null
    filterSize: string | null
  }[]
  accessCodes: readonly { id: string; type: string; label: string | null }[]
  shutoffs: readonly { id: string; type: string; description: string | null }[]
  /// The work order's own thread with staff (COMM-06, R-032) - already
  /// resolved and property-local-timestamped, oldest first.
  messages: readonly { id: string; body: string; sentAt: string; fromStaff: boolean }[]
  respondAction: (state: VendorFormState, formData: FormData) => Promise<VendorFormState>
  uploadAction: (state: VendorFormState, formData: FormData) => Promise<VendorFormState>
  completeAction: () => Promise<VendorFormState>
  revealAction: (accessCodeId: string) => Promise<{ code?: string; error?: string }>
  messageAction: (state: VendorFormState, formData: FormData) => Promise<VendorFormState>
}

const PRIORITY_LABELS: Record<string, string> = {
  EMERGENCY: 'Emergency',
  URGENT: 'Urgent',
  ROUTINE: 'Routine',
}

export function VendorJob({
  job,
  photos,
  appliances,
  accessCodes,
  shutoffs,
  messages,
  respondAction,
  uploadAction,
  completeAction,
  revealAction,
  messageAction,
}: VendorJobProps) {
  const [respondState, respondFormAction] = useActionState<VendorFormState, FormData>(
    respondAction,
    {},
  )
  const [uploadState, uploadFormAction] = useActionState<VendorFormState, FormData>(
    uploadAction,
    {},
  )
  const [completeState, completeFormAction] = useActionState<VendorFormState, FormData>(
    () => completeAction(),
    {},
  )
  const [messageState, messageFormAction] = useActionState<VendorFormState, FormData>(
    messageAction,
    {},
  )
  const [proposing, setProposing] = useState(false)
  const [declining, setDeclining] = useState(false)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [revealError, setRevealError] = useState<string | null>(null)

  const answered = job.vendorResponse != null
  const working = job.vendorResponse === 'ACCEPTED' || job.vendorResponse === 'PROPOSED_TIME'
  const errors = respondState.fieldErrors ?? {}

  async function reveal(accessCodeId: string) {
    setRevealError(null)
    const result = await revealAction(accessCodeId)
    if (result.error) setRevealError(result.error)
    else if (result.code) setRevealed((prior) => ({ ...prior, [accessCodeId]: result.code! }))
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-4">
      <header className="flex flex-col gap-1">
        <p className="text-muted-foreground text-sm">
          {PRIORITY_LABELS[job.priority] ?? job.priority} job
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{job.scope}</h1>
      </header>

      <section className="flex flex-col gap-2 rounded-md border p-4">
        <h2 className="text-sm font-medium">Where</h2>
        <p className="text-sm">
          {job.address}
          <br />
          {job.propertyName} — {job.unitName}
        </p>
        <a
          href={`https://maps.google.com/?q=${encodeURIComponent(job.address)}`}
          className="text-sm underline underline-offset-4"
          target="_blank"
          rel="noreferrer"
        >
          Open in maps
        </a>
      </section>

      {job.tenantPhone && (
        <section className="flex flex-col gap-2 rounded-md border p-4">
          <h2 className="text-sm font-medium">Who to call</h2>
          <p className="text-sm">
            {job.tenantFirstName ?? 'The tenant'} —{' '}
            <a href={`tel:${job.tenantPhone}`} className="underline underline-offset-4">
              {job.tenantPhone}
            </a>
          </p>
        </section>
      )}

      {job.ticketDescription && (
        <section className="flex flex-col gap-2 rounded-md border p-4">
          <h2 className="text-sm font-medium">What was reported</h2>
          <p className="whitespace-pre-wrap text-sm">{job.ticketDescription}</p>
        </section>
      )}

      {photos.length > 0 && (
        <section className="flex flex-col gap-2 rounded-md border p-4">
          <h2 className="text-sm font-medium">Photos</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {photos.map((photo) => (
              <li key={photo.id}>
                <a href={photo.href} className="underline underline-offset-4" target="_blank" rel="noreferrer">
                  {photo.fileName}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {appliances.length > 0 && (
        <section className="flex flex-col gap-2 rounded-md border p-4">
          <h2 className="text-sm font-medium">Equipment on site</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {appliances.map((a) => (
              <li key={a.id} className="text-muted-foreground">
                {a.category}
                {a.make && ` — ${a.make}`}
                {a.model && ` ${a.model}`}
                {a.serialNumber && ` (SN ${a.serialNumber})`}
                {a.filterSize && ` · filter ${a.filterSize}`}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!answered && (
        <section className="flex flex-col gap-4 rounded-md border-2 p-4">
          <h2 className="text-base font-medium">Can you take this job?</h2>
          <FormAlerts state={respondState} />
          <form action={respondFormAction} className="flex flex-col gap-3">
            {!declining && !proposing && (
              <>
                <input type="hidden" name="response" value="ACCEPTED" />
                <SubmitButton label="Accept this job" />
              </>
            )}

            {proposing && (
              <>
                <input type="hidden" name="response" value="PROPOSED_TIME" />
                <TextField
                  label="I can start"
                  name="proposedStart"
                  idPrefix="vendor"
                  type="datetime-local"
                  required
                  error={errors.proposedStart}
                />
                <TextField
                  label="I expect to finish"
                  name="proposedEnd"
                  idPrefix="vendor"
                  type="datetime-local"
                  required
                  error={errors.proposedEnd}
                />
                <SubmitButton label="Send this time" />
              </>
            )}

            {declining && (
              <>
                <input type="hidden" name="response" value="DECLINED" />
                <TextField
                  label="Why not? (so we send the right person next)"
                  name="declineReason"
                  idPrefix="vendor"
                  required
                  error={errors.declineReason}
                />
                <SubmitButton label="Decline this job" />
              </>
            )}
          </form>

          <div className="flex flex-wrap gap-3 text-sm">
            {!proposing && (
              <button
                type="button"
                onClick={() => {
                  setProposing(true)
                  setDeclining(false)
                }}
                className="min-h-11 underline underline-offset-4"
              >
                Propose a different time
              </button>
            )}
            {!declining && (
              <button
                type="button"
                onClick={() => {
                  setDeclining(true)
                  setProposing(false)
                }}
                className="min-h-11 underline underline-offset-4"
              >
                I can&rsquo;t take this
              </button>
            )}
            {(proposing || declining) && (
              <button
                type="button"
                onClick={() => {
                  setProposing(false)
                  setDeclining(false)
                }}
                className="min-h-11 underline underline-offset-4"
              >
                Back
              </button>
            )}
          </div>
        </section>
      )}

      {answered && !working && (
        <section className="rounded-md border p-4 text-sm">
          <p>You declined this job. Thanks for letting us know.</p>
        </section>
      )}

      {working && (
        <>
          {job.proposedStart && (
            <section className="rounded-md border p-4 text-sm">
              <p>
                You proposed {job.proposedStart} to {job.proposedEnd}. We&rsquo;ll confirm.
              </p>
            </section>
          )}

          {(accessCodes.length > 0 || shutoffs.length > 0) && (
            <section className="flex flex-col gap-3 rounded-md border p-4">
              <h2 className="text-sm font-medium">Getting in</h2>
              {revealError && (
                <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                  {revealError}
                </p>
              )}
              {accessCodes.map((code) => (
                <div key={code.id} className="flex flex-wrap items-center gap-3 text-sm">
                  <span>{code.label ?? code.type}</span>
                  {revealed[code.id] ? (
                    <code className="rounded bg-muted px-2 py-1 font-mono">{revealed[code.id]}</code>
                  ) : (
                    <button
                      type="button"
                      onClick={() => reveal(code.id)}
                      className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                    >
                      Show code
                    </button>
                  )}
                </div>
              ))}
              {shutoffs.map((s) => (
                <p key={s.id} className="text-muted-foreground text-sm">
                  {s.type} shutoff: {s.description ?? 'see the office'}
                </p>
              ))}
              <p className="text-muted-foreground text-xs">
                Every time a code is shown here it is recorded, with the date and time.
              </p>
            </section>
          )}

          <section className="flex flex-col gap-4 rounded-md border p-4">
            <h2 className="text-sm font-medium">When you&rsquo;re done</h2>
            <FormAlerts state={uploadState} />
            <form action={uploadFormAction} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="field-vendor-kind" className="text-sm font-medium">
                  What is this?
                </label>
                <select
                  id="field-vendor-kind"
                  name="kind"
                  required
                  defaultValue="COMPLETION_PHOTO"
                  className="border-input bg-background min-h-11 rounded-md border px-3 py-2 text-base"
                >
                  <option value="COMPLETION_PHOTO">A photo of the finished work</option>
                  <option value="INVOICE">The invoice</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="field-vendor-file" className="text-sm font-medium">
                  Photo or file
                </label>
                <input
                  id="field-vendor-file"
                  name="file"
                  type="file"
                  accept="image/*,application/pdf"
                  required
                  className="min-h-11 text-base"
                />
                <p className="text-muted-foreground text-xs">
                  A photo of a handwritten invoice is fine.
                </p>
              </div>
              <TextField
                label="Invoice total (only if this is the invoice)"
                name="invoiceDollars"
                idPrefix="vendor"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
              />
              <SubmitButton label="Upload" />
            </form>

            {job.status !== 'WORK_COMPLETE' && (
              <form action={completeFormAction} className="border-t pt-4">
                <FormAlerts state={completeState} />
                <SubmitButton label="Mark the work finished" />
              </form>
            )}
            {job.status === 'WORK_COMPLETE' && (
              <p className="text-muted-foreground border-t pt-4 text-sm">
                Marked finished. Thanks{job.invoiceUploaded ? '' : ' - send the invoice when you have it'}.
              </p>
            )}
          </section>
        </>
      )}

      {/*
        OUTSIDE the `working` branch, deliberately - a vendor deciding
        whether to take the job is exactly when they might have a
        clarifying question, and gating messaging behind "accept the job
        first" would shut off the one channel that could help them decide.
      */}
      <section aria-labelledby="vendor-messages" className="flex flex-col gap-3 border-t pt-4">
        <h2 id="vendor-messages" className="text-lg font-semibold">
          Messages
        </h2>
        {messages.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing yet.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {messages.map((message) => (
              <li
                key={message.id}
                className={`flex flex-col gap-1 rounded-md border p-3 text-sm ${
                  message.fromStaff ? 'bg-muted/40' : ''
                }`}
              >
                <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span>{message.fromStaff ? 'Office' : 'You'}</span>
                  <span>{message.sentAt}</span>
                </div>
                <p className="whitespace-pre-wrap">{message.body}</p>
              </li>
            ))}
          </ol>
        )}
        <form action={messageFormAction} className="flex flex-col gap-3">
          <FormAlerts state={messageState} />
          <label htmlFor="field-vendor-message-body" className="sr-only">
            Message the office
          </label>
          <textarea
            id="field-vendor-message-body"
            name="body"
            rows={3}
            required
            className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          />
          <SubmitButton label="Send" />
        </form>
      </section>
    </main>
  )
}
