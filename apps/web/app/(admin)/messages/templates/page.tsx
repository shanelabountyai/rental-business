import Link from 'next/link'
import { actorCan, requirePermission } from '@/lib/auth/guard.ts'
import { listTemplates } from '@/lib/comms/templates.ts'

export const metadata = { title: 'Message templates — Rental Operations' }

// The managed template library (COMM-03, R-049).
//
// PORTFOLIO-WIDE, so `requirePermission` with no resource — a template is not
// owned by a property, and the same violation notice is sent from all of
// them. That is the same shape as R-010's jurisdiction rules, and the one
// case where a resource-less check is right rather than the bug it usually is.
//
// NO `loading.tsx` HERE OR ABOVE: this route has no notFound() of its own, but
// the detail page beneath it does, and a Suspense boundary above would stream
// a 200 before it ran (R-099).

export default async function TemplatesPage() {
  await requirePermission('template.write')
  const [templates, canApprove] = await Promise.all([
    listTemplates(true),
    actorCan('template.approve'),
  ])

  const needingApproval = templates.flatMap((template) =>
    template.kind === 'LEGAL'
      ? template.translations.filter((t) => t.approvedAt == null)
      : [],
  )

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/messages"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Messages
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Message templates</h1>
        <p className="text-muted-foreground text-sm">
          The things you send more than once. Write them with merge fields, see
          exactly what a tenant will get, then send.
        </p>
      </header>

      {needingApproval.length > 0 && (
        // NAMED ON THE LIST, not left to be discovered. An unapproved
        // translation on a legal notice is not inert: it means tenants who
        // read that language are receiving the notice in English instead, and
        // nobody finds out unless the screen says so.
        <p className="rounded-md border border-amber-300 px-3 py-2 text-sm dark:border-amber-900">
          {needingApproval.length === 1
            ? 'One translation of a legal notice has not been approved, so it is not being used.'
            : `${needingApproval.length} translations of legal notices have not been approved, so they are not being used.`}{' '}
          {canApprove
            ? 'Open the template to review and approve it.'
            : 'Somebody with approval rights needs to review them.'}
        </p>
      )}

      <div className="flex flex-col gap-3">
        <Link
          href="/messages/templates/new"
          className="bg-foreground text-background min-h-11 w-fit rounded-md px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          New template
        </Link>

        {templates.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No templates yet. The first one is usually the rent reminder you
            retype every month.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {templates.map((template) => (
              <li key={template.id} className="rounded-lg border p-3">
                <Link
                  href={`/messages/templates/${template.id}`}
                  className="focus-visible:ring-ring font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
                >
                  {template.name}
                </Link>
                <p className="text-muted-foreground mt-1 text-sm">
                  {template.kind === 'LEGAL' ? 'Legal notice' : 'Routine message'}
                  {!template.active && ' · retired'}
                  {template.translations.length > 0 &&
                    ` · ${template.translations
                      .map((t) => `${t.locale}${t.approvedAt ? '' : ' (unapproved)'}`)
                      .join(', ')}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
