'use client'

import { friendlyBusinessDate } from '@rental/core/scheduling'
import { LiveRegion } from '@/components/auth-form.tsx'
import { TextareaField } from '@/components/form/field.tsx'
import type { RetaliationAckView } from '@/lib/leases/retaliation-check.ts'

// The retaliation warning and its reason field (RISK-06, R-055), in ONE
// place (R-212).
//
// It used to be a copy per form, and there were two: the rent raise and the
// notice to vacate. R-212 armed the guard on three more paths - the renewal
// offer, opening an eviction case and drafting a cure notice - and five
// copies of an amber box is how the wording drifts and how the next path
// gets built without one.
//
// ALWAYS MOUNTED, with the region outside the condition. A live region that
// arrives with its text already inside announces nothing (R-101), and this
// panel appears only in response to the press it is refusing.
export function RetaliationAck({
  view,
  label,
  defending,
  idPrefix,
  defaultValue,
  error,
}: {
  view: RetaliationAckView | undefined
  /// The question put to whoever is about to go ahead. MUST be unique on the
  /// assembled page - `/leases/[id]` renders both the lifecycle panel's and
  /// the renewal panel's, and two controls sharing an accessible name is a
  /// strict-mode failure and an ambiguity for anyone navigating by label.
  label: string
  /// What the reason defends, in "...is what this {defending} would be
  /// defended with".
  defending: string
  idPrefix: string
  /// The reason as last typed, when another warning on the same press
  /// refused - React 19 resets an uncontrolled field once the action
  /// returns, and this is the field whose loss used to loop (R-212).
  defaultValue?: string
  error?: string
}) {
  return (
    <LiveRegion>
      {view && (
        <div className="flex flex-col gap-2 rounded-md border-2 border-amber-500 p-3">
          <p className="text-sm font-medium">
            {view.daysAgo} day{view.daysAgo === 1 ? '' : 's'} after this tenant&rsquo;s{' '}
            {view.description} ({friendlyBusinessDate(view.occurredOn)}) — inside the{' '}
            {view.windowDays}-day retaliation-presumption window
          </p>
          <p className="text-muted-foreground text-sm">
            You can go ahead, but the business reason is recorded permanently and is what
            this {defending} would be defended with.
          </p>
          <TextareaField
            label={label}
            name="retaliationReason"
            idPrefix={idPrefix}
            required
            defaultValue={defaultValue}
            key={`retaliation-${defaultValue ?? ''}`}
            error={error}
            rows={2}
          />
        </div>
      )}
    </LiveRegion>
  )
}
