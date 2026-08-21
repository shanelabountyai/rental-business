import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'

export const metadata = { title: 'Reports — Rental Operations' }

// The five weekly operating reports, as first-class views (RPT-04, R-076).
//
// TWO OF THE FIVE ARE EXISTING PAGES, UNCHANGED OR EXTENDED IN PLACE - not
// duplicated here. Rent roll + delinquency aging was already a real report
// (R-044); open work orders by age/priority was a real page missing only
// its own sort (fixed on that page directly, see its own comment); vacancy
// and turn status is the same /vacancies page R-050 built, extended with
// turnover stage and this week's leasing activity. Only cash summary and
// upcoming critical dates were genuinely new.
export default async function ReportsPage() {
  await requireScope('property.read')

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Weekly reports</h1>
        <p className="text-muted-foreground text-sm">
          The five operating reports RPT-04 names, each a real filtered view rather than a
          dead-end number.
        </p>
      </header>

      <ul className="flex flex-col divide-y rounded-md border">
        <li>
          <Link
            href="/money/rent-roll"
            className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
          >
            <span className="font-medium">Rent roll + delinquency aging</span>
            <span className="text-muted-foreground text-sm">
              Every live tenancy, what is owed, and how long it has been owed.
            </span>
          </Link>
        </li>
        <li>
          <Link
            href="/workorders"
            className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
          >
            <span className="font-medium">Open work orders by age &amp; priority</span>
            <span className="text-muted-foreground text-sm">
              Worst priority first, oldest within a priority first.
            </span>
          </Link>
        </li>
        <li>
          <Link
            href="/vacancies"
            className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
          >
            <span className="font-medium">Vacancy &amp; turn status</span>
            <span className="text-muted-foreground text-sm">
              Days vacant, turnover stage, rent-ready ETA, and this week&rsquo;s leasing activity.
            </span>
          </Link>
        </li>
        <li>
          <Link
            href="/reports/cash"
            className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
          >
            <span className="font-medium">Cash summary per entity</span>
            <span className="text-muted-foreground text-sm">
              Collected vs. billed and the biggest outflows, by legal entity.
            </span>
          </Link>
        </li>
        <li>
          <Link
            href="/reports/dates"
            className="hover:bg-accent focus-visible:ring-ring flex min-h-14 flex-col justify-center gap-0.5 px-4 py-3 focus-visible:ring-2 focus-visible:-outline-offset-2 focus-visible:outline-none"
          >
            <span className="font-medium">Upcoming critical dates</span>
            <span className="text-muted-foreground text-sm">
              Lease expirations, insurance renewals, and deposit-return deadlines, next 60 days.
            </span>
          </Link>
        </li>
      </ul>
    </div>
  )
}
