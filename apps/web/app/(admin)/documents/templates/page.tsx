import Link from 'next/link'
import { requirePermission } from '@/lib/auth/guard.ts'
import { listDocumentTemplates } from '@/lib/documents/template-queries.ts'
import { PRIMARY_BUTTON_CLASSES } from '@/components/ui-classes.ts'

export const metadata = { title: 'Document templates — Rental Operations' }

// The document template library (DOC-04, R-062) - the same shape
// /messages/templates already gives message templates, one level over: a
// generated PDF instead of an email/SMS.

export default async function DocumentTemplatesPage() {
  await requirePermission('template.write')
  const templates = await listDocumentTemplates()

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Document templates</h1>
        <p className="text-muted-foreground text-sm">
          Letters, estoppel certificates, and anything else you generate more than
          once. Write them with merge fields, generate a PDF per recipient.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <Link
          href="/documents/templates/new"
          className={`${PRIMARY_BUTTON_CLASSES} w-fit`}
        >
          New template
        </Link>

        {templates.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No templates yet. An estoppel certificate for a property sale is the
            usual first one.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {templates.map((template) => (
              <li key={template.id} className="rounded-lg border p-3">
                <Link
                  href={`/documents/templates/${template.id}`}
                  className="focus-visible:ring-ring font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
                >
                  {template.name}
                </Link>
                <p className="text-muted-foreground mt-1 text-sm">
                  {template.documentType}
                  {!template.active && ' · retired'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
