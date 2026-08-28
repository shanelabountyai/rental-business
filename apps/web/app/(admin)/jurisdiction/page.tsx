import { friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { actorCan, requirePermission } from '@/lib/auth/guard.ts'
import { listCurrentRules } from '@/lib/jurisdiction/queries.ts'

export const metadata = { title: 'Jurisdiction rules — Rental Operations' }

function summarize(rule: {
  graceDays: number
  lateFeeType: string
  lateFeePercentBps: number | null
  lateFeeFlatCents: number | null
  entryNoticeHours: number | null
  depositDispositionDays: number | null
  reviewedBy: string | null
}): string {
  const lateFee =
    rule.lateFeeType === 'NONE'
      ? 'no late fee'
      : rule.lateFeeType === 'PERCENT_OF_RENT'
        ? `${((rule.lateFeePercentBps ?? 0) / 100).toFixed(1)}% late fee`
        : rule.lateFeeType === 'FLAT'
          ? `$${((rule.lateFeeFlatCents ?? 0) / 100).toFixed(0)} late fee`
          : 'late fee configured'
  const parts = [
    `${rule.graceDays}-day grace`,
    lateFee,
    rule.depositDispositionDays != null
      ? `${rule.depositDispositionDays}-day deposit return`
      : null,
    rule.entryNoticeHours != null ? `${rule.entryNoticeHours}h entry notice` : null,
  ].filter(Boolean)
  return parts.join(' · ')
}

// R-010: "nothing anywhere reads a statutory number any other way" only holds
// if there is somewhere a human can see what is currently configured before
// trusting the resolver with it. Portfolio-wide, like /properties/entities -
// a JurisdictionRule applies by state, not by property or entity, so there is
// no scoped list to build here.
export default async function JurisdictionRulesPage({
  searchParams,
}: {
  searchParams: Promise<{ versioned?: string }>
}) {
  await requirePermission('jurisdiction.read')
  const [rules, canWrite, { versioned }] = await Promise.all([
    listCurrentRules(new Date()),
    actorCan('jurisdiction.write'),
    searchParams,
  ])

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Jurisdiction rules
          </h1>
          <p className="text-muted-foreground max-w-prose text-sm">
            The single source of every statutory number (D-4): grace days,
            late-fee caps, deposit deadlines, entry-notice hours and notice
            periods. All drafts requiring attorney review before real-world
            use - this is a learning project, not legal advice.
          </p>
        </div>
        {canWrite && (
          <Link
            href="/jurisdiction/new"
            className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 items-center rounded-md px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            New configuration
          </Link>
        )}
      </header>

      {versioned && (
        <p
          role="status"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          Added a new version for {versioned}.
        </p>
      )}

      {rules.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No jurisdictions configured yet. Every property needs one before it
          can compute fees, deposits or notices.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {rules.map((rule) => (
            <li key={rule.id} className="flex flex-col gap-1 px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {rule.state}
                  {rule.jurisdiction ? ` — ${rule.jurisdiction}` : ' — Statewide'}
                </span>
                <span className="text-muted-foreground text-sm">
                  v{rule.version} · effective{' '}
                  {friendlyBusinessDate(utcToBusinessDate(rule.effectiveFrom))}
                  {!rule.reviewedBy && ' · unreviewed'}
                </span>
              </div>
              <p className="text-muted-foreground text-sm">
                {summarize(rule)}
              </p>
              {canWrite && (
                <Link
                  href={`/jurisdiction/new?state=${rule.state}${rule.jurisdiction ? `&jurisdiction=${encodeURIComponent(rule.jurisdiction)}` : ''}`}
                  className="text-sm font-medium underline underline-offset-2"
                >
                  Add new version
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
