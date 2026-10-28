import { friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { notFound } from 'next/navigation'
import { requirePlatform } from '@/lib/platform/guard.ts'
import { INTEGRATION_SELECT, orgOwners, providerName } from '@/lib/platform/orgs.ts'
import { OrgHealthPanel } from '@/components/platform/org-health.tsx'
import Link from 'next/link'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Organisation' }

// PRD 11 §4.4 (R-303): what the platform may know about one organisation,
// and a stated line that nothing inside it shows without a grant (D-320).
// Read side only. Not here yet, each with the row that builds it: status and
// its history (R-300), the checklist (R-291), grants and "Request access"
// (R-295), the fee (R-296), pending invites (R-304), the kill-switch toggle
// (R-306). "Re-run" is on /platform/jobs (R-303b, PRD 11 §4.10).
export default async function PlatformOrgPage({ params }: { params: Promise<{ slug: string }> }) {
  await requirePlatform({ permission: 'org.read' })
  const { slug } = await params
  const org = await prisma.organization.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      notificationsEnabled: true,
      createdAt: true,
      health: true,
      integrations: { select: INTEGRATION_SELECT, orderBy: { provider: 'asc' } },
    },
  })
  if (!org) notFound()
  const owners = await orgOwners(org.id)
  const now = new Date()

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2 break-words">
        <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
        <p className="text-muted-foreground text-sm">
          {org.slug} · created {friendlyTimestamp(org.createdAt, 'UTC')} · notifications{' '}
          {org.notificationsEnabled ? 'on' : 'switched off'}
        </p>
        <Link href="/platform/orgs" className="text-sm underline underline-offset-4">
          Back to organisations
        </Link>
      </header>

      <p className="rounded-md border p-4 text-sm">
        Viewing inside this organisation needs a support grant. Its properties, tenants, leases, money, messages,
        documents, staff and audit log are not shown here.
      </p>

      <section aria-labelledby="owners-heading" className="flex flex-col gap-2 rounded-md border p-4 text-sm">
        <h2 id="owners-heading" className="text-lg font-semibold">
          Owners
        </h2>
        {owners.length === 0 ? (
          <p>No active owner.</p>
        ) : (
          <ul className="flex flex-col gap-1 break-words">
            {owners.map((owner) => (
              <li key={owner.id}>
                {owner.name} · <a href={`mailto:${owner.email}`} className="underline underline-offset-4">{owner.email}</a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="integrations-heading" className="flex flex-col gap-2 rounded-md border p-4 text-sm">
        <h2 id="integrations-heading" className="text-lg font-semibold">
          Integrations
        </h2>
        {org.integrations.length === 0 ? (
          <p>No integrations started.</p>
        ) : (
          <ul className="flex flex-col gap-2 break-words">
            {org.integrations.map((i) => (
              <li key={i.provider} className="flex flex-col">
                <span className="font-medium">
                  {providerName(i.provider)}: {i.status.toLowerCase().replaceAll('_', ' ')}
                </span>
                {/* The provider's reason, verbatim (§4.4). */}
                {i.statusReason && <span>{i.statusReason}</span>}
                <span className="text-muted-foreground">updated {friendlyTimestamp(i.updatedAt, 'UTC')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <OrgHealthPanel health={org.health} now={now} />
    </main>
  )
}
