'use client'

import { useActionState } from 'react'
import { FormAlerts, SubmitButton } from '@/components/auth-form.tsx'
import { CheckboxField } from '@/components/form/field.tsx'
import type { BidComparison } from '@rental/core/approvals'
import type { WorkOrderFormState } from '@/lib/workorders/actions.ts'
import { scrollableRegionProps } from '@/components/ui-classes.ts'

// "Compares responses in one view" (MAINT-04, R-026). One table, cheapest
// first, with the vendors who never answered still on it - a comparison that
// silently drops the two who ignored you tells the wrong story about how
// much shopping around actually happened.

function money(cents: number | null): string {
  if (cents == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
}

export function BidsPanel({
  comparison,
  vendors,
  requestAction,
}: {
  comparison: BidComparison | null
  vendors: readonly { id: string; name: string; trades: readonly string[] }[]
  requestAction: (state: WorkOrderFormState, formData: FormData) => Promise<WorkOrderFormState>
}) {
  const [state, formAction] = useActionState<WorkOrderFormState, FormData>(requestAction, {})

  return (
    <div className="flex flex-col gap-4 rounded-md border p-4">
      <h2 className="text-sm font-medium">Bids</h2>

      {comparison && comparison.bids.length > 0 && (
        <>
          <div className="overflow-x-auto" {...scrollableRegionProps('Vendor bids, scrolls sideways')}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th scope="col" className="pb-1 font-medium">Vendor</th>
                  <th scope="col" className="pb-1 font-medium">Price</th>
                  <th scope="col" className="pb-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {comparison.bids.map((bid) => (
                  <tr key={bid.vendorId} className="border-t">
                    <td className="py-1">{bid.vendorName}</td>
                    <td
                      className={
                        bid.amountCents != null && bid.amountCents === comparison.lowestCents
                          ? 'py-1 font-medium'
                          : 'py-1'
                      }
                    >
                      {money(bid.amountCents)}
                      {bid.amountCents != null &&
                        bid.amountCents === comparison.lowestCents &&
                        ' (lowest)'}
                    </td>
                    <td className="text-muted-foreground py-1">
                      {bid.declinedAt
                        ? 'Not bidding'
                        : bid.respondedAt
                          ? 'Quoted'
                          : 'No answer yet'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!comparison.enoughToCompare && (
            <p className="text-muted-foreground text-sm">
              {comparison.quotedCount === 0
                ? 'No prices back yet.'
                : 'Only one price so far - MAINT-04 suggests two or three before choosing.'}
            </p>
          )}
        </>
      )}

      {vendors.length > 0 && (
        <form action={formAction} className="flex flex-col gap-3">
          <FormAlerts state={state} />
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Ask for a price</legend>
            {vendors.map((vendor) => (
              <CheckboxField
                key={vendor.id}
                label={`${vendor.name}${vendor.trades.length > 0 ? ` (${vendor.trades.join(', ')})` : ''}`}
                name="vendorIds"
                value={vendor.id}
              />
            ))}
          </fieldset>
          <SubmitButton label="Request bids" />
        </form>
      )}
    </div>
  )
}
