import { requirePlatform } from '@/lib/platform/guard.ts'
import { platformSettings } from '@/lib/platform/settings.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Platform settings' }

// PRD 11 §4.12 (R-303b). Read-only by design; see lib/platform/settings.ts.
export default async function PlatformSettingsPage() {
  await requirePlatform({ permission: 'org.read' })
  const lines = platformSettings(process.env)

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Platform settings</h1>
        <p className="text-muted-foreground text-sm">
          Read-only. Nothing here changes from the browser, because a switch that needs the database cannot stop a
          database incident. Secrets show only whether they are set.
        </p>
        <a href="/platform" className="text-sm underline underline-offset-4">
          Back to the console
        </a>
      </header>
      <dl className="flex flex-col divide-y rounded-md border text-sm">
        {lines.map((line) => (
          <div key={line.name} className="flex flex-col gap-1 px-4 py-3 break-words">
            <dt className="font-mono font-medium">{line.name}</dt>
            <dd className="font-medium">{line.shown}</dd>
            <dd className="text-muted-foreground">
              {line.does} Changed in: {line.where}.
            </dd>
          </div>
        ))}
      </dl>
    </main>
  )
}
