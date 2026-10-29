import { prisma } from '@rental/db'
import { friendlyBusinessDate, utcToBusinessDate } from '@rental/core/scheduling'
import Link from 'next/link'
import { SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'
import { listCurrentRules } from '@/lib/jurisdiction/queries.ts'
import { platformDecision, requirePlatform } from '@/lib/platform/guard.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Jurisdiction rules' }

// PRD 11 §4.11 (R-305, D-355). The rule library every org reads, beside how
// many orgs have a property in each state - from `OrgHealth.states` (D-354),
// so the publisher knows whose tenants a version governs without the console
// reading any org's properties.

export default async function PlatformJurisdictionPage({
  searchParams,
}: {
  searchParams: Promise<{ versioned?: string }>
}) {
  const admin = await requirePlatform({ permission: 'org.read' })
  const [rules, canPublish, health, { versioned }] = await Promise.all([
    listCurrentRules(new Date()),
    platformDecision(admin, 'jurisdiction.publish').then((d) => d.allowed || d.reason === 'stepup_required'),
    prisma.orgHealth.findMany({ select: { states: true } }),
    searchParams,
  ])
  const orgsIn = new Map<string, number>()
  for (const { states } of health) for (const state of states) orgsIn.set(state, (orgsIn.get(state) ?? 0) + 1)
  const orgCount = (state: string) => {
    const n = orgsIn.get(state) ?? 0
    return `${n} org${n === 1 ? '' : 's'} with properties here`
  }
  const configured = new Set(rules.filter((r) => !r.jurisdiction).map((r) => r.state))
  const uncovered = [...orgsIn.keys()].filter((state) => !configured.has(state)).sort()

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Jurisdiction rules</h1>
        <p className="text-muted-foreground text-sm">
          Every organisation reads these. A new version governs every tenancy in its state from its effective date, and
          each organisation with a property there tells its owners. Drafts for attorney review, not legal advice.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <a href="/platform" className="text-sm underline underline-offset-4">
            Back to the console
          </a>
          {canPublish && (
            <Link
              href="/platform/jurisdiction/new"
              className={`${SUBMIT_BUTTON_CLASSES} flex min-h-11 items-center px-4 py-2 text-sm`}
            >
              New configuration
            </Link>
          )}
        </div>
      </header>

      {versioned && (
        <p role="status" className="rounded-md border border-success/35 bg-success/6 px-3 py-2 text-sm text-success">
          Published a new version for {versioned}.
        </p>
      )}

      {uncovered.length > 0 && (
        <section
          aria-labelledby="uncovered-heading"
          className="flex flex-col gap-2 rounded-md border border-warning/35 bg-warning/6 p-4 text-sm text-warning"
        >
          <h2 id="uncovered-heading" className="text-lg font-semibold">
            States with properties and no statewide rule
          </h2>
          <ul className="flex flex-wrap gap-x-3">
            {uncovered.map((state) => (
              <li key={state}>
                {canPublish ? (
                  <Link href={`/platform/jurisdiction/new?state=${state}`} className="font-medium underline underline-offset-2">
                    {state}
                  </Link>
                ) : (
                  state
                )}{' '}
                ({orgCount(state)})
              </li>
            ))}
          </ul>
        </section>
      )}

      {rules.length === 0 ? (
        <p className="text-sm">No jurisdictions configured yet.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border text-sm">
          {rules.map((rule) => (
            <li key={rule.id} className="flex flex-col gap-1 px-4 py-3 break-words">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {rule.state}
                  {rule.jurisdiction ? ` — ${rule.jurisdiction}` : ' — Statewide'}
                </span>
                <span className="text-muted-foreground">
                  v{rule.version} · effective {friendlyBusinessDate(utcToBusinessDate(rule.effectiveFrom))}
                  {!rule.reviewedBy && ' · unreviewed'}
                </span>
              </div>
              <p className="text-muted-foreground">
                {rule.citation ?? 'No citation'} · {rule.reviewedBy ? `reviewed by ${rule.reviewedBy}` : 'no reviewer'} ·{' '}
                {orgCount(rule.state)}
              </p>
              {canPublish && (
                <Link
                  href={`/platform/jurisdiction/new?state=${rule.state}${rule.jurisdiction ? `&jurisdiction=${encodeURIComponent(rule.jurisdiction)}` : ''}`}
                  className="min-h-11 content-center font-medium underline underline-offset-2"
                >
                  Publish a new {rule.state}
                  {rule.jurisdiction ? ` (${rule.jurisdiction})` : ''} version
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
