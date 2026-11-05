import { businessDate } from '@rental/core/scheduling'
import { type Decision, decisionReport, parseQuarter, quarterOf } from '@rental/core/screening'
import Link from 'next/link'
import { PageHeader } from '@/components/page-header.tsx'
import { scrollableRegionProps } from '@/components/ui-classes.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { decisionsInQuarter } from '@/lib/screening/criteria-queries.ts'

export const metadata = { title: 'Adverse-action report' }

const OUTCOMES: { key: Decision; label: string }[] = [
  { key: 'APPROVED', label: 'Approved' },
  { key: 'APPROVED_WITH_CONDITIONS', label: 'Approved with conditions' },
  { key: 'DECLINED', label: 'Declined' },
]

// R-297 (PRD 10 §7.1): one org's screening decisions for a quarter - the
// record an org hands counsel or a HUD inquiry. Read-only and owner-only:
// `screening.criteria.write` is the owner's portfolio-wide grant, the same
// one that writes the criteria and reasons these decisions rest on.
export default async function AdverseActionReportPage({
  searchParams,
}: {
  searchParams: Promise<{ quarter?: string }>
}) {
  const actor = await requirePermission('screening.criteria.write')
  const { quarter: asked } = await searchParams
  const thisQuarter = quarterOf(businessDate(new Date(), 'UTC'))
  const quarter = parseQuarter(asked ?? thisQuarter) ?? parseQuarter(thisQuarter)!
  const report = decisionReport(await decisionsInQuarter(actor.orgId, quarter))

  const [year, q] = quarter.label.split('-Q').map(Number) as [number, number]
  const previous = q === 1 ? `${year - 1}-Q4` : `${year}-Q${q - 1}`
  const next = q === 4 ? `${year + 1}-Q1` : `${year}-Q${q + 1}`

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Adverse-action report">
        <p className="text-muted-foreground max-w-prose text-sm">
          Every screening decision recorded in {quarter.label}, by outcome,
          reason and property, dated in each property&apos;s own time zone.
          Days to decision run from the household&apos;s complete application.
        </p>
      </PageHeader>

      <nav aria-label="Quarter" className="flex flex-wrap items-center gap-4 text-sm">
        <Link href={`/screening-criteria/report?quarter=${previous}`} className="underline underline-offset-2">
          Previous quarter<span className="sr-only">, {previous}</span>
        </Link>
        <span className="font-medium">{quarter.label}</span>
        <Link href={`/screening-criteria/report?quarter=${next}`} className="underline underline-offset-2">
          Next quarter<span className="sr-only">, {next}</span>
        </Link>
        <a
          href={`/screening-criteria/report/export?quarter=${quarter.label}`}
          className="underline underline-offset-2"
        >
          Download CSV<span className="sr-only"> for {quarter.label}</span>
        </a>
      </nav>

      {report.total === 0 ? (
        <p className="text-muted-foreground text-sm">No decisions were recorded in {quarter.label}.</p>
      ) : (
        <>
          <section aria-labelledby="by-outcome" className="flex flex-col gap-1 text-sm">
            <h2 id="by-outcome" className="font-semibold">
              By outcome
            </h2>
            <ul className="flex flex-col gap-1">
              {OUTCOMES.map((o) => (
                <li key={o.key}>
                  {o.label}: {report.byOutcome[o.key]}
                </li>
              ))}
              <li>Total: {report.total}</li>
              <li>
                Days to decision:{' '}
                {report.medianDaysToDecision == null
                  ? 'not measurable'
                  : `median ${report.medianDaysToDecision}, longest ${report.maxDaysToDecision}`}
              </li>
            </ul>
          </section>

          <section aria-labelledby="by-reason" className="flex flex-col gap-1 text-sm">
            <h2 id="by-reason" className="font-semibold">
              By reason
            </h2>
            {report.byReason.length === 0 ? (
              <p className="text-muted-foreground">No decision named a reason.</p>
            ) : (
              <ul className="flex flex-col gap-1 break-words">
                {report.byReason.map((r) => (
                  <li key={r.code}>
                    {r.label}: {r.count}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="by-property" className="flex flex-col gap-1 text-sm">
            <h2 id="by-property" className="font-semibold">
              By property
            </h2>
            <div className="overflow-x-auto" {...scrollableRegionProps('Decisions by property')}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Property
                    </th>
                    {OUTCOMES.map((o) => (
                      <th key={o.key} scope="col" className="py-2 pr-4 text-right font-medium">
                        {o.label}
                      </th>
                    ))}
                    <th scope="col" className="py-2 pr-4 text-right font-medium">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.byProperty.map((p) => (
                    <tr key={p.propertyName} className="border-b">
                      <th scope="row" className="py-2 pr-4 text-left font-normal">
                        {p.propertyName}
                      </th>
                      {OUTCOMES.map((o) => (
                        <td key={o.key} className="py-2 pr-4 text-right">
                          {p.byOutcome[o.key]}
                        </td>
                      ))}
                      <td className="py-2 pr-4 text-right">{p.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
