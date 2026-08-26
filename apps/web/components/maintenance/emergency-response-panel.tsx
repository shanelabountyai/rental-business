'use client'

import { useActionState } from 'react'
import type { MaintenanceFormState } from '@/lib/maintenance/actions.ts'
import { PRIMARY_BUTTON_CLASSES } from '@/components/ui-classes.ts'

// The 3am panel (MAINT-12, NOTIF-05, R-029).
//
// Two things, in the order somebody standing in a car park needs them:
// acknowledge, so the escalation chain stops and the owner is not woken up
// next; then the phone numbers of whoever answers for this trade. Every
// phone number is a `tel:` link, because the next thing that happens after
// reading this screen is a call.
//
// REAL FORM SUBMISSIONS, not onClick handlers. A handler does nothing until
// React has hydrated, and a dead "I have this" button at 3am on a bad
// connection means the chain escalates to the owner while somebody is
// already driving to the property.

type Action = (
  previous: MaintenanceFormState,
  formData: FormData,
) => Promise<MaintenanceFormState>

export interface EmergencyVendorRow {
  id: string
  name: string
  phone: string | null
  emergencyAvailable: boolean
}

export function EmergencyResponsePanel({
  ticketId,
  acknowledged,
  trade,
  vendors,
  canEditVendors,
  acknowledge,
  setEmergencyAvailability,
}: {
  ticketId: string
  acknowledged: { at: string; by: string | null } | null
  trade: string | null
  vendors: EmergencyVendorRow[]
  canEditVendors: boolean
  acknowledge: Action
  setEmergencyAvailability: Action
}) {
  const [ackState, ackAction, ackPending] = useActionState<
    MaintenanceFormState,
    FormData
  >(acknowledge, {})
  const [vendorState, vendorAction, vendorPending] = useActionState<
    MaintenanceFormState,
    FormData
  >(setEmergencyAvailability, {})
  const error = ackState.error ?? vendorState.error

  return (
    <section
      aria-labelledby="emergency-response"
      className="flex flex-col gap-4 rounded-md border border-red-300 p-4 dark:border-red-900"
    >
      <h2 id="emergency-response" className="text-lg font-semibold">
        Emergency response
      </h2>

      {acknowledged ? (
        <p className="text-sm" role="status">
          Acknowledged {acknowledged.at}
          {acknowledged.by ? ` by ${acknowledged.by}` : ''}. The escalation
          chain has stopped.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            Nobody has acknowledged this yet. If it is still unacknowledged 15
            minutes after it came in, everybody else with authority over the
            property gets paged too.
          </p>
          <form action={ackAction}>
            <input type="hidden" name="ticketId" value={ticketId} />
            <button
              type="submit"
              disabled={ackPending}
              className={`${PRIMARY_BUTTON_CLASSES} self-start disabled:opacity-60`}
            >
              I have this
            </button>
          </form>
        </div>
      )}

      {trade && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Who answers for {trade}</h3>
          {vendors.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No active {trade} vendor on file.
            </p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {vendors.map((vendor) => (
                <li key={vendor.id} className="flex flex-wrap items-center gap-2">
                  <span>{vendor.name}</span>
                  {vendor.phone ? (
                    <a
                      href={`tel:${vendor.phone}`}
                      className="underline underline-offset-4"
                    >
                      {vendor.phone}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">no phone on file</span>
                  )}
                  {vendor.emergencyAvailable && (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-900 dark:bg-green-950 dark:text-green-100">
                      Answers after hours
                    </span>
                  )}
                  {canEditVendors && (
                    <form action={vendorAction}>
                      <input type="hidden" name="vendorId" value={vendor.id} />
                      <input
                        type="hidden"
                        name="available"
                        value={vendor.emergencyAvailable ? 'no' : 'yes'}
                      />
                      <button
                        type="submit"
                        disabled={vendorPending}
                        className="focus-visible:ring-ring text-muted-foreground min-h-11 text-xs underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
                      >
                        {vendor.emergencyAvailable
                          ? `Mark ${vendor.name} as daytime only`
                          : `Mark ${vendor.name} as answering after hours`}
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </section>
  )
}
