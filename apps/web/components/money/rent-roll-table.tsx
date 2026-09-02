'use client'

import { useActionState, useState } from 'react'
import { BUCKET_LABELS } from '@rental/core/ledger'
import type { AgingBucket } from '@rental/core/ledger'
import { formatCents } from '@rental/core/money'
import { friendlyBusinessDate } from '@rental/core/scheduling'
import { LiveRegion } from '@/components/auth-form.tsx'
import { FieldError } from '@/components/form/field.tsx'
import type { ReminderFormState } from '@/lib/payments/reminders.ts'
import { ACCENT_BUTTON_CLASSES, scrollableRegionProps } from '@/components/ui-classes.ts'

// The rent roll, and the one action that chases everybody on it (PAY-06,
// R-044).
//
// ==========================================================================
// "SELECT ALL" MEANS "SELECT ALL PAST GRACE", NEVER "SELECT EVERY ROW.
//
// The screen shows the whole portfolio, because PAY-06 asks for a rent roll —
// every lease, paid or not. The bulk action chases people. Wiring one
// checkbox to the other would let a single click select a tenant who paid on
// time, and the reminder they receive is the kind of mistake that costs a
// renewal.
//
// Rows that are not chaseable have no checkbox at all rather than a disabled
// one: there is nothing the user could do to make them selectable, so a
// control that looks available and refuses is worse than no control. The
// reason is written in the row instead.
// ==========================================================================

export interface Row {
  leaseId: string
  propertyName: string
  unitName: string
  tenantName: string
  rentCents: number
  balanceCents: number
  daysLate: number
  bucket: AgingBucket
  pastGrace: boolean
  autopay: boolean
  depositHeldCents: number
  subsidyCents: number
  lastContactOn: string | null
  graceUnknown: boolean
  chaseHeld: boolean
}

export function RentRollTable({
  rows,
  templates,
  canSend,
  sendAction,
}: {
  rows: Row[]
  templates: { id: string; name: string }[]
  canSend: boolean
  sendAction: (
    previous: ReminderFormState,
    formData: FormData,
  ) => Promise<ReminderFormState>
}) {
  const [state, action, pending] = useActionState<ReminderFormState, FormData>(
    sendAction,
    {},
  )
  // A held tenancy is past grace AND not chaseable, which is the case this
  // list did not have until R-084 introduced it. It must drop out here and
  // not merely at send time: it feeds "select all N past grace", and a count
  // that includes a tenancy under an automatic stay is an invitation to
  // press the one button that violates it.
  const chaseable = rows.filter((row) => row.pastGrace && !row.chaseHeld)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggle = (leaseId: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(leaseId)) next.delete(leaseId)
      else next.add(leaseId)
      return next
    })

  const allChaseableSelected =
    chaseable.length > 0 && chaseable.every((row) => selected.has(row.leaseId))

  return (
    <form action={action} className="flex flex-col gap-4">
      {/* OUTSIDE the panel below, and always mounted while the user can send.
          What the last press did is not conditional on there still being
          somebody left to chase — and the case where there is not is exactly
          the interesting one: press Send on a stale selection whose only
          tenancy has just gone under a hold, and the panel that would have
          carried the refusal is the thing that disappears. The result then
          renders nowhere and the operator is told nothing at all, which is
          worse than the wrong reason this walk started out fixing. Always
          mounted rather than conditionally, so `aria-live` has somewhere to
          announce into rather than arriving with the text already in it —
          the self-replacing-panel trap R-086 documents at length. */}
      {canSend && (
        <div>
          <FieldError id="reminder-error" message={state.error} />
          <LiveRegion>
            {state.notice && <p className="text-sm">{state.notice}</p>}
          </LiveRegion>
        </div>
      )}

      {canSend && chaseable.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <h2 className="text-sm font-medium">Chase everyone past grace</h2>
          <p className="text-muted-foreground text-sm">
            {chaseable.length} {chaseable.length === 1 ? 'tenancy is' : 'tenancies are'} past
            the grace period their state allows. Tenants still inside it are
            not listed here and cannot be selected.
          </p>

          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-5"
              checked={allChaseableSelected}
              onChange={() =>
                setSelected(
                  allChaseableSelected
                    ? new Set()
                    : new Set(chaseable.map((row) => row.leaseId)),
                )
              }
            />
            Select all {chaseable.length} past grace
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Template</span>
            <select
              name="templateId"
              required
              className="border-input bg-background focus-visible:ring-ring min-h-11 rounded-md border px-3 py-2 text-base focus-visible:ring-2 focus-visible:outline-none"
            >
              <option value="">Choose a template…</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>

          {templates.length === 0 && (
            <p className="text-muted-foreground text-sm">
              There are no templates yet. Write one first — a reminder typed
              fresh each month is the thing this screen exists to stop.
            </p>
          )}

          <button
            type="submit"
            disabled={pending || selected.size === 0 || templates.length === 0}
            className={`${ACCENT_BUTTON_CLASSES} self-start disabled:opacity-60`}
          >
            {selected.size === 0
              ? 'Send reminder'
              : `Send reminder to ${selected.size} selected`}
          </button>
        </div>
      )}

      <div className="overflow-x-auto" {...scrollableRegionProps('Rent roll, scrolls sideways')}>
        <table className="w-full text-sm">
          <caption className="sr-only">
            Every live tenancy with rent, balance, how late it is, autopay
            status, deposit held, subsidy portion and when the tenant was last
            contacted.
          </caption>
          <thead>
            <tr className="text-muted-foreground border-b text-left text-xs">
              {canSend && <th scope="col" className="py-2 pr-2 font-medium">Chase</th>}
              <th scope="col" className="py-2 pr-3 font-medium">Tenancy</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Rent</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Balance</th>
              <th scope="col" className="py-2 pr-3 font-medium">How late</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Deposit held</th>
              <th scope="col" className="py-2 font-medium">Last contacted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.leaseId} className="border-b last:border-0">
                {canSend && (
                  <td className="py-2 pr-2">
                    {row.pastGrace && !row.chaseHeld ? (
                      // WRAPPED FOR THE TARGET SIZE (R-116, 2.5.8). A bare
                      // `size-5` checkbox is a 20px target, and this is the
                      // box that decides whether a tenant gets a collection
                      // reminder. The "select all" directly above it was
                      // already inside a `min-h-11` label; the per-row ones
                      // were missed. The `aria-label` still wins over the
                      // (empty) label text for the accessible name.
                      <label className="flex min-h-11 min-w-11 items-center justify-center">
                        <input
                          type="checkbox"
                          name="leaseIds"
                          value={row.leaseId}
                          checked={selected.has(row.leaseId)}
                          onChange={() => toggle(row.leaseId)}
                          className="size-5"
                          aria-label={`Chase ${row.tenantName}`}
                        />
                      </label>
                    ) : (
                      // No control at all, not a disabled one. Nothing the
                      // user can do would make this selectable — and for a
                      // hold, the one thing that would is lifting it, which
                      // is not a thing to nudge somebody towards from a
                      // chase screen.
                      <span className="sr-only">
                        {row.chaseHeld ? 'Not chaseable while a hold is in force' : 'Not past grace'}
                      </span>
                    )}
                  </td>
                )}
                <td className="py-2 pr-3">
                  {row.tenantName}
                  <span className="text-muted-foreground block text-xs">
                    {row.propertyName} · {row.unitName}
                    {row.autopay && ' · autopay'}
                    {row.subsidyCents > 0 &&
                      ` · ${formatCents(row.subsidyCents)} subsidy`}
                  </span>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatCents(row.rentCents)}
                </td>
                <td
                  className={`py-2 pr-3 text-right tabular-nums ${
                    row.balanceCents > 0 ? 'font-medium' : 'text-muted-foreground'
                  }`}
                >
                  {row.balanceCents < 0
                    ? `${formatCents(Math.abs(row.balanceCents))} credit`
                    : formatCents(row.balanceCents)}
                </td>
                <td className="py-2 pr-3">
                  {row.bucket === 'current' ? (
                    <span className="text-muted-foreground">Current</span>
                  ) : (
                    <>
                      {BUCKET_LABELS[row.bucket]}
                      {/* THE DISTINCTION THIS SCREEN MUST MAKE. Being in a
                          late bucket is not the same as being chaseable, and
                          a reader who cannot see which is which will assume
                          they are the same thing. */}
                      <span className="text-muted-foreground block text-xs">
                        {row.graceUnknown
                          ? 'no rule configured for this state'
                          : row.chaseHeld
                            ? // Deliberately does NOT contain the words "past
                              // grace": `getByText` is a substring match, and
                              // a held row answering to that phrase would let
                              // a future test believe the chase was on offer.
                              'chase paused by a hold'
                            : row.pastGrace
                              ? 'past grace'
                              : 'still within grace'}
                      </span>
                    </>
                  )}
                </td>
                <td className="text-muted-foreground py-2 pr-3 text-right tabular-nums">
                  {formatCents(row.depositHeldCents)}
                </td>
                <td className="text-muted-foreground py-2">
                  {row.lastContactOn ? friendlyBusinessDate(row.lastContactOn) : 'never'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </form>
  )
}
