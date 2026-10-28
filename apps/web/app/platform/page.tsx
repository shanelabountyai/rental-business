import { prisma } from '@rental/db'
import { platformDecision, requirePlatform } from '@/lib/platform/guard.ts'
import { signOutOfPlatform } from '@/lib/platform/auth-actions.ts'
import { ORG_SUMMARY_SELECT, attentionReasons } from '@/lib/platform/orgs.ts'
import { SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'
import Link from 'next/link'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Platform console' }

// PRD 11 §4.2 (R-303). Every admin lands here, so the session is all the page
// asks; the organisation panels show only to holders of `org.read`, and an
// admin without it still gets their account and the way out.
//
// Not here yet, each with the row that builds it: counts by org status
// (R-300 adds `Organization.status`), live break-glass grants, old support
// requests and the admin's own grants (R-295).
export default async function PlatformHomePage() {
  const admin = await requirePlatform()
  const canRead = (await platformDecision(admin, 'org.read')).allowed
  const orgs = canRead ? await prisma.organization.findMany({ select: ORG_SUMMARY_SELECT, orderBy: { name: 'asc' } }) : []
  const now = new Date()
  const attention = orgs
    .map((org) => ({ org, reasons: attentionReasons(org, now) }))
    .filter((row) => row.reasons.length > 0)

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Platform console</h1>
        <p className="text-muted-foreground text-sm break-words">
          Signed in as {admin.name} ({admin.email}).
        </p>
        <nav aria-label="Console" className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {canRead && (
            <Link href="/platform/orgs" className="underline underline-offset-4">
              Organisations
            </Link>
          )}
          <Link href="/platform/admins" className="underline underline-offset-4">
            Platform admins
          </Link>
          <a href="/platform/account" className="underline underline-offset-4">
            Your account
          </a>
        </nav>
      </header>

      {canRead && (
        <>
          <section aria-labelledby="orgs-heading" className="flex flex-col gap-2 text-sm">
            <h2 id="orgs-heading" className="text-lg font-semibold">
              Organisations
            </h2>
            <p>{orgs.length === 0 ? 'No organisations yet.' : `${orgs.length} organisation${orgs.length === 1 ? '' : 's'}.`}</p>
          </section>

          <section aria-labelledby="attention-heading" className="flex flex-col gap-2 text-sm">
            <h2 id="attention-heading" className="text-lg font-semibold">
              Needs attention
            </h2>
            {attention.length === 0 ? (
              <p>Nothing needs attention.</p>
            ) : (
              <ul className="flex flex-col divide-y rounded-md border">
                {attention.map(({ org, reasons }) => (
                  <li key={org.id} className="flex flex-col gap-1 px-4 py-3 break-words">
                    <Link href={`/platform/orgs/${org.slug}`} className="font-medium underline underline-offset-4">
                      {org.name}
                    </Link>
                    <span>{reasons.join(' · ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <form action={signOutOfPlatform}>
        <button type="submit" className={`${SUBMIT_BUTTON_CLASSES} min-h-11 px-4 py-2 text-base`}>
          Sign out
        </button>
      </form>
    </main>
  )
}
