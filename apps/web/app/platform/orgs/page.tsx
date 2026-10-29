import { prisma } from '@rental/db'
import { platformDecision, requirePlatform } from '@/lib/platform/guard.ts'
import { ORG_SUMMARY_SELECT, healthIsStale, providerName } from '@/lib/platform/orgs.ts'
import { HealthFreshness, runOutcome } from '@/components/platform/org-health.tsx'
import { INPUT_CLASSES, SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'
import Link from 'next/link'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Organisations' }

// PRD 11 §4.3 (R-303). Search is a plain GET form, so it works before
// hydration. Not here yet: the status filter and column (R-300), checklist
// n/10 (R-291), open grants (R-295) and the fee (R-296).
export default async function PlatformOrgsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const admin = await requirePlatform({ permission: 'org.read' })
  // Shown to holders of `org.create`; the press asks for the code (R-304a).
  const decision = await platformDecision(admin, 'org.create')
  const canCreate = decision.allowed || decision.reason === 'stepup_required'
  const q = (await searchParams).q?.trim() ?? ''
  const orgs = await prisma.organization.findMany({
    where: q
      ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { slug: { contains: q, mode: 'insensitive' } }] }
      : undefined,
    select: ORG_SUMMARY_SELECT,
    orderBy: { name: 'asc' },
  })
  const now = new Date()

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Organisations</h1>
        <a href="/platform" className="text-sm underline underline-offset-4">
          Back to the console
        </a>
        {canCreate && (
          <Link href="/platform/orgs/new" className="text-sm underline underline-offset-4">
            Create an organisation
          </Link>
        )}
      </header>
      <form method="get" role="search" className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium">
          Search by name or slug
          <input name="q" defaultValue={q} className={INPUT_CLASSES} />
        </label>
        <button type="submit" className={`${SUBMIT_BUTTON_CLASSES} min-h-11 px-4 py-2`}>
          Search
        </button>
      </form>
      {orgs.length === 0 ? (
        <p className="text-sm">{q ? 'No organisations match.' : 'No organisations yet.'}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {orgs.map((org) => (
            <li key={org.id} className="flex flex-col gap-1 px-4 py-3 text-sm break-words">
              <Link href={`/platform/orgs/${org.slug}`} className="font-medium underline underline-offset-4">
                {org.name}
              </Link>
              <span className="text-muted-foreground">{org.slug}</span>
              <span>
                {org.integrations.length === 0
                  ? 'No integrations started'
                  : org.integrations.map((i) => `${providerName(i.provider)}: ${i.status.toLowerCase().replaceAll('_', ' ')}`).join(' · ')}
              </span>
              <span>
                <HealthFreshness health={org.health} now={now} />
                {org.health && !healthIsStale(org.health, now) && (
                  <>
                    {' '}
                    · daily run {runOutcome(org.health.dailyAt, org.health.dailyOk)} · {org.health.deadLetters} dead-lettered
                  </>
                )}
              </span>
              {!org.notificationsEnabled && <span className="font-medium">Notifications switched off</span>}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
