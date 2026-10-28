import { requirePlatform } from '@/lib/platform/guard.ts'
import { signOutOfPlatform } from '@/lib/platform/auth-actions.ts'
import { SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Platform console' }

// R-294b's landing: proof of a platform session and the way out of it.
// R-303 replaces the body with the dashboard (PRD 11 §4.2).
export default async function PlatformHomePage() {
  const admin = await requirePlatform()
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Platform console</h1>
        <p className="text-muted-foreground text-sm break-words">
          Signed in as {admin.name} ({admin.email}).
        </p>
        <a href="/platform/account" className="text-sm underline underline-offset-4">
          Your account
        </a>
      </header>
      <form action={signOutOfPlatform}>
        <button type="submit" className={`${SUBMIT_BUTTON_CLASSES} min-h-11 px-4 py-2 text-base`}>
          Sign out
        </button>
      </form>
    </main>
  )
}
