import { prisma } from '@rental/db'
import { redirect } from 'next/navigation'
import { auth } from '@/auth.ts'
import { MfaEnrolment } from '@/components/mfa-enrolment.tsx'
import {
  beginMfaEnrolment,
  confirmMfaEnrolment,
  signOutEverywhere,
} from '@/lib/auth/actions.ts'

export const metadata = { title: 'Your account — Rental Operations' }

// The only route R-003 protects. R-007 builds the admin shell and R-004 puts
// real authorization in front of everything; this page exists so the session
// and the MFA enrolment flow have somewhere to live and something to test.
export default async function AccountPage() {
  const session = await auth()
  if (session?.principal.kind !== 'staff') redirect('/login')

  const credential = await prisma.staffCredential.findUnique({
    where: { staffUserId: session.principal.id },
    select: { mfaEnrolledAt: true },
  })

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-8 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Your account</h1>
        <p className="text-muted-foreground text-sm">
          {session.principal.name} · {session.principal.email}
        </p>
      </header>

      <section aria-labelledby="mfa" className="flex flex-col gap-3">
        <h2 id="mfa" className="text-lg font-semibold">
          Two-factor authentication
        </h2>
        <p className="text-muted-foreground text-sm">
          Required before you can approve spending, adjust a ledger or change
          anyone&rsquo;s access.
        </p>
        <MfaEnrolment
          enrolled={credential?.mfaEnrolledAt != null}
          begin={beginMfaEnrolment}
          confirm={confirmMfaEnrolment}
        />
      </section>

      <section aria-labelledby="sessions" className="flex flex-col gap-3">
        <h2 id="sessions" className="text-lg font-semibold">
          Sessions
        </h2>
        <form action={signOutEverywhere}>
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
