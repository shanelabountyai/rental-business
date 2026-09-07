import type { PlanOfferRow } from '@/lib/payments/plan-report.ts'
import { scrollableRegionProps } from '@/components/ui-classes.ts'

// PAY-04's fair-housing shape, asked about repayment plans (R-175).
//
// A server component: numbers and text, no state.
//
// THIS REPORTS A PATTERN AND NEVER A VERDICT — the same wording, and the same
// care over it, as the waiver report beside it. A repayment plan is the
// decision that avoids a filing fee, an attorney and a month of vacancy, and
// it is currently made case by case in one person's head. Offering one to
// some tenants and not others, along lines that happen to correlate with a
// protected class, is a discrimination pattern regardless of intent.
//
// It lists the tenancies that were never offered a plan FIRST and loudest.
// A report of plans alone would show only leniency and hide its distribution
// — and the households nobody offered anything to are the half an operator
// is least likely to go looking for.

const STATUS_LABEL: Record<NonNullable<PlanOfferRow['latestPlanStatus']>, string> = {
  ACTIVE: 'in force',
  COMPLETED: 'paid in full',
  BROKEN: 'broken',
  CANCELLED: 'cancelled',
}

export function PlanOfferPattern({ rows }: { rows: readonly PlanOfferRow[] }) {
  const notOffered = rows.filter((row) => !row.offered).length

  return (
    <section aria-labelledby="plan-offers" className="flex flex-col gap-3 border-t pt-6">
      <div className="flex flex-col gap-1">
        <h2 id="plan-offers" className="text-lg font-semibold">
          Repayment plans by tenant
        </h2>
        <p className="text-muted-foreground text-sm">
          Every tenancy that reached a collections step — a late or
          returned-payment fee, or a notice actually served — and whether a
          repayment plan was ever agreed with it. Shown because who gets
          offered an arrangement and who goes straight to a notice is a
          fair-housing risk whatever the intent behind it.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No tenancy has reached a collections step yet, so there is no pattern
          to show.
        </p>
      ) : (
        <>
          <div
            className="overflow-x-auto"
            {...scrollableRegionProps('Repayment plans by tenant, scrolls sideways')}
          >
            <table className="w-full text-sm">
              <caption className="sr-only">
                Per tenancy: how many late or returned-payment fees were
                charged, how many notices were served, how many repayment plans
                were agreed and where the most recent one stands. Never-offered
                first.
              </caption>
              <thead>
                <tr className="text-muted-foreground text-left text-xs">
                  {/* NO TWO OF THESE MAY SOUND ALIKE (R-116). A screen reader
                      repeats the header with every cell, and this is a table
                      whose whole point is telling one count from another. */}
                  <th scope="col" className="py-1 pr-3 font-medium">
                    Tenant
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    Fees charged
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    Notices served
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    Plans agreed
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Where the latest plan stands
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.tenantId}>
                    <td className="py-2 pr-3 align-top">{row.tenantName}</td>
                    <td className="py-2 pr-3 text-right align-top tabular-nums">
                      {row.feesAssessed}
                    </td>
                    <td className="py-2 pr-3 text-right align-top tabular-nums">
                      {row.noticesServed}
                    </td>
                    <td className="py-2 pr-3 text-right align-top tabular-nums">
                      {row.plansAgreed}
                    </td>
                    <td className="py-2 align-top">
                      {row.latestPlanStatus ? (
                        STATUS_LABEL[row.latestPlanStatus]
                      ) : (
                        // SPELLED OUT, not left as a zero in the column
                        // before it. The zero is the finding.
                        <span className="font-medium">never offered a plan</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-muted-foreground text-xs">
            {notOffered} of {rows.length}{' '}
            {rows.length === 1 ? 'tenancy was' : 'tenancies were'} never offered
            a plan. That is worth understanding, not worth assuming about — a
            tenant who never asked, and one who broke two plans already, are
            not the same case as one nobody offered.
          </p>
        </>
      )}
    </section>
  )
}
