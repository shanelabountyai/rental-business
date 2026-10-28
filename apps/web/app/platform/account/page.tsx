import { friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { RecoveryCodesPanel } from '@/components/platform/recovery-codes-panel.tsx'
import {
  regeneratePlatformRecoveryCodes,
  signOutOfPlatformEverywhere,
} from '@/lib/platform/auth-actions.ts'
import { requirePlatform } from '@/lib/platform/guard.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Your platform account' }

// PRD 11 §4.1 (R-294c). A platform admin belongs to no property, so there is
// no zone to show times in but UTC, which `friendlyTimestamp` names.
export default async function PlatformAccountPage() {
  const admin = await requirePlatform()
  const credential = await prisma.platformCredential.findUnique({
    where: { platformAdminId: admin.id },
    select: { mfaEnrolledAt: true, mfaRecoveryCodes: true },
  })

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-8 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Your platform account</h1>
        <a href="/platform" className="text-sm underline underline-offset-4">
          Back to the console
        </a>
      </header>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm break-words sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Name</dt>
        <dd>{admin.name}</dd>
        <dt className="text-muted-foreground">Email</dt>
        <dd>{admin.email}</dd>
        <dt className="text-muted-foreground">Two-factor set up</dt>
        <dd>{credential?.mfaEnrolledAt ? friendlyTimestamp(credential.mfaEnrolledAt, 'UTC') : 'Not set up'}</dd>
      </dl>

      <section aria-labelledby="recovery" className="flex flex-col gap-3">
        <h2 id="recovery" className="text-lg font-semibold">
          Recovery codes
        </h2>
        <RecoveryCodesPanel
          remaining={credential?.mfaRecoveryCodes.length ?? 0}
          action={regeneratePlatformRecoveryCodes}
        />
      </section>

      <section aria-labelledby="sessions" className="flex flex-col gap-3">
        <h2 id="sessions" className="text-lg font-semibold">
          Sessions
        </h2>
        <form action={signOutOfPlatformEverywhere}>
          <button
            type="submit"
            className="border-input focus-visible:ring-ring min-h-11 rounded-md border px-4 py-2 text-base font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Sign out of every device
          </button>
        </form>
      </section>
    </main>
  )
}
