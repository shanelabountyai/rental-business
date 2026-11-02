import { supportGrantStatus } from '@rental/core/rbac'
import { prisma } from '@rental/db'
import Link from 'next/link'
import { GRANT_LIST_SELECT, GrantList, type GrantRow } from '@/components/platform/grant-list.tsx'
import { platformDecision, requirePlatform } from '@/lib/platform/guard.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Support grants' }

// PRD 11 §4.7 (R-295a): your own grants - live, pending, ended - and, with
// `platformAudit.read` (§3.1's name for the PRD's "audit.read" here, D-366),
// every admin's. Any admin may see their own: it is their own record.
export default async function PlatformGrantsPage() {
  const admin = await requirePlatform()
  const everyone = (await platformDecision(admin, 'platformAudit.read')).allowed
  const now = new Date()
  const own = await prisma.supportAccessGrant.findMany({
    where: { platformAdminId: admin.id },
    select: GRANT_LIST_SELECT,
    orderBy: { requestedAt: 'desc' },
    take: 200,
  })
  const others = everyone
    ? await prisma.supportAccessGrant.findMany({
        where: { platformAdminId: { not: admin.id } },
        select: GRANT_LIST_SELECT,
        orderBy: { requestedAt: 'desc' },
        take: 200,
      })
    : []
  const by = (statuses: string[]) => (g: GrantRow) => statuses.includes(supportGrantStatus(g, now))

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Support grants</h1>
        <Link href="/platform" className="text-sm underline underline-offset-4">
          Back to the console
        </Link>
      </header>
      {(
        [
          ['live-heading', 'Your live grants', own.filter(by(['live']))],
          ['pending-heading', 'Your pending requests', own.filter(by(['pending']))],
          ['ended-heading', 'Your ended, denied and expired grants', own.filter(by(['ended', 'denied', 'expired']))],
          ...(everyone ? [['all-heading', "Every other admin's grants", others] as const] : []),
        ] as const
      ).map(([id, title, grants]) => (
        <section key={id} aria-labelledby={id} className="flex flex-col gap-3 text-sm">
          <h2 id={id} className="text-lg font-semibold">
            {title}
          </h2>
          <GrantList grants={[...grants]} viewerId={admin.id} now={now} />
        </section>
      ))}
    </main>
  )
}
