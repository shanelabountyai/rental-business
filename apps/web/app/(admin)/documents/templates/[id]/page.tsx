import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DocumentTemplateForm } from '@/components/documents/document-template-form.tsx'
import { GenerateDocumentForm } from '@/components/documents/generate-document-form.tsx'
import { RetireDocumentTemplateForm } from '@/components/documents/retire-document-template-form.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { generateDocumentFromTemplate } from '@/lib/documents/generate.ts'
import { retireDocumentTemplate, saveDocumentTemplate } from '@/lib/documents/template-actions.ts'
import { DOCUMENT_TYPE_OPTIONS, getDocumentTemplate } from '@/lib/documents/template-queries.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'

export const metadata = { title: 'Document template — Rental Operations' }

// NO `loading.tsx` HERE OR ABOVE. This page calls notFound() and a Suspense
// boundary above it would stream a 200 before the page ran (R-099).

export default async function DocumentTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const actor = await requirePermission('template.write')

  const template = await getDocumentTemplate(id)
  if (!template) notFound()

  const scope = await currentScope(actor)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/documents/templates"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Document templates
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{template.name}</h1>
        <p className="text-muted-foreground text-sm">
          {template.documentType}
          {!template.active && ' · retired'}
        </p>
      </header>

      <DocumentTemplateForm
        defaults={{
          name: template.name,
          documentType: template.documentType,
          body: template.body,
          state: template.state ?? undefined,
          addendumKey: template.addendumKey ?? undefined,
        }}
        documentTypeOptions={DOCUMENT_TYPE_OPTIONS}
        action={saveDocumentTemplate.bind(null, template.id)}
      />

      <RetireDocumentTemplateForm
        action={retireDocumentTemplate.bind(null, template.id)}
        active={template.active}
      />

      {template.active && (
        <section aria-labelledby="generate" className="flex flex-col gap-3">
          <h2 id="generate" className="text-lg font-semibold">
            Generate
          </h2>
          <GenerateDocumentForm
            action={generateDocumentFromTemplate.bind(null, template.id)}
            properties={scope.availableProperties}
          />
        </section>
      )}
    </div>
  )
}
