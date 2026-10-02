import Link from 'next/link'
import { DocumentTemplateForm } from '@/components/documents/document-template-form.tsx'
import { PageHeader } from '@/components/page-header.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { saveDocumentTemplate } from '@/lib/documents/template-actions.ts'
import { DOCUMENT_TYPE_OPTIONS } from '@/lib/documents/template-queries.ts'

export const metadata = { title: 'New document template — Rental Operations' }

export default async function NewDocumentTemplatePage() {
  await requirePermission('template.write')

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/documents/templates"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Document templates
        </Link>
        <PageHeader title="New document template" />
      </header>

      <DocumentTemplateForm
        defaults={{ name: '', documentType: '', body: '' }}
        documentTypeOptions={DOCUMENT_TYPE_OPTIONS}
        // Bound server-side. A plain function cannot cross this boundary and
        // `npm run build` does not catch the difference.
        action={saveDocumentTemplate.bind(null, null)}
      />
    </div>
  )
}
