import { AuthCard, Field } from '@/components/auth-form.tsx'
import { SUBMIT_BUTTON_CLASSES } from '@/components/ui-classes.ts'
import { hostOrgId } from '@/lib/auth/org.ts'
import { FINAL_EXPORT_REFUSED, usableFinalExportLink } from '@/lib/org-lifecycle/final-export-link.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Download your final export' }

// R-300b (D-388): the emailed link to an offboarded org's final export. The
// link alone opens nothing: the download is a POST that also carries the
// owner's authenticator code. A plain form, not an action, because the answer
// is the file itself.
export default async function FinalExportPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ error?: string }>
}) {
  const { token } = await params
  const { error } = await searchParams
  const link = await usableFinalExportLink(token, await hostOrgId())
  if (!link) {
    return (
      <AuthCard title="That link cannot be used">
        <p className="text-sm">{FINAL_EXPORT_REFUSED}</p>
      </AuthCard>
    )
  }
  return (
    <AuthCard
      title={`Final export of ${link.organization.name}`}
      description="Everything the organisation held, as one zip file. Enter the current code from your authenticator app to download it."
    >
      <form method="post" action="/api/final-export" className="flex flex-col gap-4">
        <input type="hidden" name="token" value={token} />
        {error && (
          <p id="code-error" role="alert" className="text-sm text-red-700 dark:text-red-400">
            That code did not work. Enter the current code from your authenticator app, or a recovery code.
          </p>
        )}
        <Field
          label="Authenticator code"
          name="code"
          autoComplete="one-time-code"
          invalid={Boolean(error)}
          describedBy={error ? 'code-error' : undefined}
          autoFocus
        />
        <button type="submit" className={SUBMIT_BUTTON_CLASSES}>
          Download
        </button>
      </form>
    </AuthCard>
  )
}
