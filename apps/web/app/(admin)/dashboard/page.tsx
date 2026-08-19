import { formatCents } from '@rental/core/money'
import Link from 'next/link'
import { requireScope } from '@/lib/auth/guard.ts'
import { dashboardSummary } from '@/lib/dashboard/queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Dashboard — Rental Operations' }

// The owner's exception-first landing screen (RPT-01, RPT-04, R-050).
//
// EVERY TILE IS A LINK, AND EVERY LINK IS A REAL FILTERED LIST - "no
// dead-end numbers" is R-050's own requirement. Where the destination page
// already existed (rent roll, maintenance, leases, tasks) the link carries a
// searchParam that page now understands; where none existed (vacancies,
// renewals) this item built one. See lib/dashboard/queries.ts's own header
// for what each tile reuses versus what's new, and the one place a tile's
// label is deliberately narrower than "compliance" would suggest.
//
// Guards itself rather than relying on the layout (ROLE-01), same as every
// other admin section.

const CARD =
  'hover:bg-accent focus-visible:ring-ring flex flex-col gap-1 rounded-lg border p-3 focus-visible:ring-2 focus-visible:outline-none'
const CARD_GLOW =
  'flex flex-col gap-1 rounded-lg border border-red-300 bg-red-50 p-3 hover:bg-red-100 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none dark:border-red-900 dark:bg-red-950 dark:hover:bg-red-900'

function Tile({
  href,
  label,
  value,
  detail,
  glow,
}: {
  href: string
  label: string
  value: string
  detail?: string
  glow?: boolean
}) {
  return (
    <li>
      <Link href={href} className={glow ? CARD_GLOW : CARD}>
        <span className="text-muted-foreground text-xs font-medium">{label}</span>
        <span className="text-xl font-semibold tabular-nums">{value}</span>
        {detail && <span className="text-muted-foreground text-xs">{detail}</span>}
      </Link>
    </li>
  )
}

export default async function DashboardPage() {
  // requireScope, NOT a bare requirePermission('property.read') - the SAME
  // dormant scoping bug R-008 found on other list pages (see requireScope's
  // own comment): a resource-less permission check asks "may you see
  // EVERYTHING", which a property-scoped manager cannot answer yes to, and
  // this is the one screen every scoped manager is expected to land on.
  const { actor } = await requireScope('property.read')
  const scope = await currentScope(actor)
  const now = new Date()
  const summary = await dashboardSummary(scope, now)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm">
          In scope right now: {scope.propertyIds.length} propert
          {scope.propertyIds.length === 1 ? 'y' : 'ies'}.
        </p>
      </header>

      {/* `<ul>`, not `<dl>` - a `<dl>`'s direct children must be `<dt>`/`<dd>`
          (WCAG 1.3.1, caught by the shell's own axe sweep). Each tile is a
          card that happens to show a stat, not a definition pair, so a list
          of links is the honest structure. */}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Tile
          href="/money/rent-roll"
          label="Collected vs billed"
          value={`${formatCents(summary.collectedVsBilled.collectedCents)} / ${formatCents(summary.collectedVsBilled.billedCents)}`}
          detail={summary.collectedVsBilled.periodLabel || undefined}
        />

        <Tile
          href="/money/rent-roll?pastGrace=1"
          label="Aged delinquency"
          value={formatCents(summary.delinquency.outstandingCents)}
          detail={`${summary.delinquency.pastGraceCount} tenanc${summary.delinquency.pastGraceCount === 1 ? 'y' : 'ies'} past grace`}
        />

        <Tile
          href={
            summary.tickets.glowingCount > 0 ? '/maintenance?glowing=1' : '/maintenance'
          }
          label="Open tickets"
          value={String(summary.tickets.openCount)}
          detail={
            summary.tickets.glowingCount > 0
              ? `${summary.tickets.glowingCount} emergency/urgent open past 48h`
              : 'None past the emergency/urgent 48h mark'
          }
          glow={summary.tickets.glowingCount > 0}
        />

        <Tile
          href="/vacancies"
          label="Vacancies"
          value={String(summary.vacancies.count)}
          detail={
            summary.vacancies.count > 0
              ? `${formatCents(summary.vacancies.totalDailyCostCents)}/day · oldest ${summary.vacancies.longestDaysOnMarket}d`
              : undefined
          }
        />

        <Tile
          href="/leases?expiresWithin=90"
          label="Leases expiring ≤90 days"
          value={String(summary.leaseExpiry.within90)}
          detail={`${summary.leaseExpiry.within120} within 120 days`}
        />

        <Tile
          href="/tasks?type=lease_renewal"
          label="Renewal rate"
          value={`${Math.round(summary.renewalRate.rate * 100)}%`}
          detail={`${summary.renewalRate.renewed} renewed · ${summary.renewalRate.endedWithoutRenewal} not renewed`}
        />

        <Tile
          href="/tasks?type=workorder_approval"
          label="Pending approvals"
          value={String(summary.pendingApprovals.count)}
        />

        <Tile
          href="/renewals"
          label="Renewals & alerts"
          value={String(summary.renewalAlerts.count)}
          detail="Mortgage & insurance dates, not statutory compliance"
        />

        <Tile
          href="/tasks?type=tenant_unanswered"
          label="Unanswered tenant messages"
          value={String(summary.unansweredMessages.count)}
          detail={
            summary.unansweredMessages.count > 0 ? 'No staff reply in 2+ days' : undefined
          }
        />
      </ul>
    </div>
  )
}
