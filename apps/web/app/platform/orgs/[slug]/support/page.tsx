import { prisma } from '@rental/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { GRANT_LIST_SELECT, GrantList } from '@/components/platform/grant-list.tsx'
import { BreakGlassForm, RequestAccessForm } from '@/components/platform/support-access.tsx'
import { platformDecision, requirePlatform } from '@/lib/platform/guard.ts'
import { openBreakGlass, requestSupportAccess } from '@/lib/platform/support-actions.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Support access' }

// PRD 11 §4.7 (R-295a): ask an organisation for access, or break the glass,
// and see every grant there has been for it. Entering a live grant is R-295b.
export default async function PlatformOrgSupportPage({ params }: { params: Promise<{ slug: string }> }) {
  const admin = await requirePlatform({ permission: 'org.read' })
  const { slug } = await params
  const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true, name: true, slug: true } })
  if (!org) notFound()
  const grants = await prisma.supportAccessGrant.findMany({
    where: { orgId: org.id },
    select: GRANT_LIST_SELECT,
    orderBy: { requestedAt: 'desc' },
    take: 100,
  })
  const canRequest = (await platformDecision(admin, 'grant.request')).allowed
  // Held is enough to see the form; the press asks for the code (D-367).
  const breakGlass = await platformDecision(admin, 'grant.breakGlass')
  const canBreakGlass = breakGlass.allowed || (!breakGlass.allowed && breakGlass.reason === 'stepup_required')

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2 break-words">
        <h1 className="text-2xl font-semibold tracking-tight">Support access: {org.name}</h1>
        <Link href={`/platform/orgs/${org.slug}`} className="text-sm underline underline-offset-4">
          Back to {org.name}
        </Link>
      </header>
      <p className="rounded-md border p-4 text-sm">
        A grant is read-only. Entering the organisation under a live grant is not built yet (R-295b).
      </p>
      {canRequest && <RequestAccessForm action={requestSupportAccess} slug={org.slug} />}
      {canBreakGlass && <BreakGlassForm action={openBreakGlass} slug={org.slug} />}
      <section aria-labelledby="grants-heading" className="flex flex-col gap-3 text-sm">
        <h2 id="grants-heading" className="text-lg font-semibold">
          Grants for this organisation
        </h2>
        <GrantList grants={grants} viewerId={admin.id} now={new Date()} />
      </section>
    </main>
  )
}
