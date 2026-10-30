import { friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { notFound } from 'next/navigation'
import { OrgConfigurePanel, OrgInvitesPanel, OrgNotificationsPanel, OrgSlugPanel } from '@/components/platform/create-org-form.tsx'
import { platformDecision, requirePlatform } from '@/lib/platform/guard.ts'
import { changeOrgSlug, configureOrganization, manageOrgInvite, switchOrgNotifications } from '@/lib/platform/org-actions.ts'
import { INTEGRATION_SELECT, orgOwners, providerName } from '@/lib/platform/orgs.ts'
import { OrgHealthPanel } from '@/components/platform/org-health.tsx'
import Link from 'next/link'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Organisation' }

// PRD 11 §4.4 (R-303): what the platform may know about one organisation,
// and a stated line that nothing inside it shows without a grant (D-320).
// Read side only. Not here yet, each with the row that builds it: status and
// its history (R-300), the checklist (R-291), grants and "Request access"
// (R-295), the fee (R-296). Pending invites
// with "Resend" and "Revoke" are R-304a's. "Re-run" is on /platform/jobs (R-303b, PRD 11 §4.10).
export default async function PlatformOrgPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ slugChanged?: string }>
}) {
  const admin = await requirePlatform({ permission: 'org.read' })
  const { slug } = await params
  const { slugChanged } = await searchParams
  const org = await prisma.organization.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      colorPrimary: true,
      colorAccent: true,
      notificationsEnabled: true,
      createdAt: true,
      health: true,
      integrations: { select: INTEGRATION_SELECT, orderBy: { provider: 'asc' } },
      invites: {
        where: { acceptedAt: null, revokedAt: null },
        select: { id: true, email: true, name: true, expiresAt: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  if (!org) notFound()
  const owners = await orgOwners(org.id)
  const now = new Date()
  const invite = await platformDecision(admin, 'org.create')
  const configure = await platformDecision(admin, 'org.configure')
  const canConfigure = configure.allowed
  const invites = org.invites.map((i) => ({
    id: i.id,
    email: i.email,
    name: i.name,
    expiryLabel: `${i.expiresAt > now ? 'expires' : 'expired'} ${friendlyTimestamp(i.expiresAt, 'UTC')}`,
  }))

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

      {slugChanged && (
        <p role="status" className="rounded-md border p-4 text-sm break-words">
          The slug was changed from {slugChanged} to {org.slug}. Staff signed in on the old address are signed out, and
          pending invitations must be resent.
        </p>
      )}

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

      <OrgConfigurePanel
        action={configureOrganization}
        slug={org.slug}
        name={org.name}
        colorPrimary={org.colorPrimary}
        colorAccent={org.colorAccent}
        canConfigure={canConfigure}
      />

      <OrgSlugPanel action={changeOrgSlug} slug={org.slug} canConfigure={canConfigure} />

      <OrgNotificationsPanel
        action={switchOrgNotifications}
        slug={org.slug}
        enabled={org.notificationsEnabled}
        canConfigure={canConfigure}
      />

      <OrgInvitesPanel
        action={manageOrgInvite}
        slug={org.slug}
        invites={invites}
        canManage={invite.allowed || invite.reason === 'stepup_required'}
      />

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
