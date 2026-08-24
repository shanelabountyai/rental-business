'use client'

import { vendorMayMarkComplete } from '@rental/core/vendors'
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
    /// The CONFIRMED window, once the office has booked and noticed it.
    /// Outranks the proposal: a vendor who proposed a time and had a
    /// different one confirmed needs to read the confirmed one.
    scheduledStart: string | null
    scheduledEnd: string | null
    /// The tenant said there is a pet at home (R-019's intake, R-032b).
    /// Shown prominently and near the top, because it is the only fact on
    /// this page that can hurt somebody: a vendor letting themselves in with
    /// a key needs it before they turn the handle, not buried under the
    /// equipment list.
    petWarning: boolean
    /// RISK-04 (R-091): who may be handed keys, codes or access on this job.
    /// Null on every ordinary job. See the schema column's own comment for
    /// why it names only the authorized party.
    restrictedPartyNote: string | null
    /// Whether the tenant agreed we may enter when they are not home. Null
    /// when there is no ticket behind the job — a staff-raised work order has
    /// nobody to have answered.
    entryPermission: boolean | null
    invoiceUploaded: boolean
    /// MAINT-06's required completion photo. Gates "mark complete", so the
    /// button can say what is missing instead of failing on press.
    completionPhotoUploaded: boolean
    /// "Received → approved → paid" (MAINT-09, R-079) - the same read the
    /// staff-side work order page shows, so nobody hears two different
    /// answers to "where's my check".
    invoiceStatusLabel: string
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

      {/* ABOVE the pet warning, and above "Where", because it governs what
          the vendor does when they get there and because a locksmith who
          reads it after handing over keys has read it too late (RISK-04,
          R-091).

          It names who MAY be given keys and never who may not. The job says
          nothing about why it exists — this is an ordinary re-key as far as
          this page, this vendor and every maintenance screen are concerned,
          and that is the protection working rather than information
          missing. */}
      {job.restrictedPartyNote && (
        <section
          role="note"
          aria-labelledby="restricted-party"
          className="flex flex-col gap-1 rounded-md border-2 border-sky-600 bg-sky-50 p-4 dark:border-sky-500 dark:bg-sky-950"
        >
          <h2
            id="restricted-party"
            className="text-sm font-semibold text-sky-900 dark:text-sky-100"
          >
            Who may be given keys on this job
          </h2>
          <p className="text-sm text-sky-900 dark:text-sky-100">{job.restrictedPartyNote}</p>
        </section>
      )}

      {/* ABOVE "Where", because it is read before somebody sets off and it
          is the only thing on this page that can hurt them. R-019 asked the
          tenant, the Ticket stored the answer, the PM could see it, and the
          person opening the door could not — for every job since R-025.

          Not a `<details>` like the access codes: a warning you have to
          expand is a warning that gets missed, and unlike a gate code there
          is no reason to withhold it until the job is accepted. */}
      {job.petWarning && (
        <section
          // `role="note"` rather than `alert`: alert interrupts, and this is
          // rendered on load rather than in response to anything the vendor
          // did. It still reads as a warning because the heading says so.
          role="note"
          aria-labelledby="pet-warning"
          className="flex flex-col gap-1 rounded-md border-2 border-amber-500 bg-amber-50 p-4 dark:border-amber-500 dark:bg-amber-950"
        >
          <h2 id="pet-warning" className="text-sm font-semibold text-amber-900 dark:text-amber-100">
            There is a pet at this home
          </h2>
          <p className="text-sm text-amber-900 dark:text-amber-100">
            The tenant told us to expect an animal.
            {job.entryPermission === true
              ? ' They have agreed we can come in when they are not home, so knock first and let them secure it if they are there.'
              : ' Arrange the visit with them so the animal is secured before you arrive.'}
          </p>
        </section>
      )}

      {/* Said explicitly rather than left to be inferred from silence. "The
          tenant has NOT agreed to entry when out" and "nobody asked" are
          different facts, and a vendor who assumes the first when it is the
          second turns up to a locked door. */}
      {job.entryPermission !== null && !job.petWarning && (
        <section className="flex flex-col gap-1 rounded-md border p-4">
          <h2 className="text-sm font-medium">Entry</h2>
          <p className="text-sm">
            {job.entryPermission
              ? 'The tenant has agreed we can come in when they are not home.'
              : 'The tenant asked that somebody be home — arrange a time with them before you go.'}
          </p>
        </section>
      )}

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

          {/* THREE FORMS, NOT ONE FORM AND A STATE MACHINE (H7/U9, R-098).
              This was `useState` with each trigger unmounting itself: tapping
              "Propose a different time" destroyed the button holding focus,
              so a keyboard or screen-reader user was returned to the top of
              the document with nothing announced. Worse, before hydration
              only Accept existed - the two answers a landlord would rather
              not hear were the ones that needed JavaScript to reach.

              Native `<details>` fixes both at once: focus stays on the
              `<summary>`, and disclosure works with no JavaScript at all.
              All three post to the same action; each carries its own
              `response`. */}
          <form action={respondFormAction} className="flex flex-col gap-3">
            <input type="hidden" name="response" value="ACCEPTED" />
            <SubmitButton label="Accept this job" />
          </form>

          <details
            className="rounded-md border p-3"
            // Stays open when the server rejected what was typed into it.
            // A closed panel would hide the error's own field.
            open={Boolean(errors.proposedStart || errors.proposedEnd)}
          >
            <summary className="min-h-11 cursor-pointer text-sm underline underline-offset-4">
              Propose a different time
            </summary>
            <form action={respondFormAction} className="flex flex-col gap-3 pt-3">
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
            </form>
          </details>

          <details className="rounded-md border p-3" open={Boolean(errors.declineReason)}>
            <summary className="min-h-11 cursor-pointer text-sm underline underline-offset-4">
              I can&rsquo;t take this
            </summary>
            <form action={respondFormAction} className="flex flex-col gap-3 pt-3">
              <input type="hidden" name="response" value="DECLINED" />
              <TextField
                label="Why not? (so we send the right person next)"
                name="declineReason"
                idPrefix="vendor"
                required
                error={errors.declineReason}
              />
              <SubmitButton label="Decline this job" />
            </form>
          </details>
        </section>
      )}

      {answered && !working && (
        <section className="rounded-md border p-4 text-sm">
          <p>You declined this job. Thanks for letting us know.</p>
        </section>
      )}

      {working && (
        <>
          {/* THE CONFIRMED WINDOW WINS. A vendor whose visit had been
              booked - and legally noticed to the tenant - still read "we'll
              confirm" and phoned the office to ask, because only the proposal
              was ever passed to this component. */}
          {job.scheduledStart ? (
            <section className="rounded-md border-2 border-foreground p-4">
              <h2 className="text-base font-semibold">When to come</h2>
              <p className="text-base">
                {job.scheduledStart}
                {job.scheduledEnd ? ` to ${job.scheduledEnd.slice(11)}` : ''}
              </p>
              <p className="text-muted-foreground text-sm">
                Confirmed with the tenant. Times are local to the property.
              </p>
            </section>
          ) : job.proposedStart ? (
            <section className="rounded-md border p-4">
              <p className="text-base">
                You proposed {job.proposedStart} to {job.proposedEnd}. We&rsquo;ll confirm.
              </p>
            </section>
          ) : null}

          {(accessCodes.length > 0 || shutoffs.length > 0) && (
            <section className="flex flex-col gap-3 rounded-md border p-4">
              <h2 className="text-sm font-medium">Getting in</h2>
              {revealError && (
                <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                  {revealError}
                </p>
              )}
              {/* THE ONE ACTION THIS SURFACE EXISTS TO PERFORM, and until
                  R-098 it did three things wrong at once: every trigger was
                  named "Show code" with nothing to tell them apart, the
                  button unmounted itself so focus fell to `<body>`, and the
                  code arrived with the region that held it, so nothing was
                  ever announced.

                  `<output>` is a live region natively, and it is rendered
                  empty from the first paint - a region inserted alongside its
                  own content announces nothing, which is the mistake S2
                  catalogued in eleven places. `autoFocus` on the revealed
                  code moves focus onto the thing the vendor asked for; it
                  fires on mount only, so it cannot re-steal focus later. */}
              {accessCodes.map((code) => {
                const name = code.label ?? code.type
                return (
                  <div key={code.id} className="flex flex-wrap items-center gap-3 text-sm">
                    <span id={`code-label-${code.id}`}>{name}</span>
                    <output aria-labelledby={`code-label-${code.id}`}>
                      {revealed[code.id] ? (
                        <code
                          tabIndex={-1}
                          autoFocus
                          className="bg-muted focus-visible:ring-ring rounded px-2 py-1 font-mono focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                        >
                          {revealed[code.id]}
                        </code>
                      ) : null}
                    </output>
                    {!revealed[code.id] && (
                      <button
                        type="button"
                        onClick={() => reveal(code.id)}
                        aria-label={`Show the ${name} code`}
                        className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-3 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                      >
                        Show code
                      </button>
                    )}
                  </div>
                )
              })}
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

          <section className="flex flex-col gap-2 rounded-md border p-4">
            <h2 className="text-sm font-medium">Invoice status</h2>
            <p className="text-sm">{job.invoiceStatusLabel}</p>
          </section>

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

            {/* The same rule the action enforces, not a second `!==
                'WORK_COMPLETE'` guess. A VERIFIED job is one the tenant has
                already confirmed and a PENDING_APPROVAL one is with the
                office - both are now reachable here (R-036b), and offering
                "mark the work finished" on either would invite the vendor to
                undo somebody else's answer. */}
            {vendorMayMarkComplete(job.status) ? (
              job.completionPhotoUploaded ? (
                <form action={completeFormAction} className="border-t pt-4">
                  <FormAlerts state={completeState} />
                  <SubmitButton label="Mark the work finished" />
                </form>
              ) : (
                // MAINT-06's required completion photo, enforced (R-032b).
                // D-17 already asserted this was "built into R-025's vendor
                // upload" while justifying deferring R-028 — it was not: the
                // upload existed and nothing required it, so a job could
                // reach WORK_COMPLETE with no evidence it was ever done.
                //
                // SAYS WHAT IS MISSING INSTEAD OF DISABLING A BUTTON. A
                // disabled control leaves the tab order and explains
                // nothing; the sentence is the affordance, and the upload it
                // asks for is directly above.
                <p className="border-t pt-4 text-sm">
                  Upload a photo of the finished work above, then you can mark
                  it complete. The photo is what shows the job was done — it is
                  what the tenant is asked to confirm against.
                </p>
              )
            ) : (
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
