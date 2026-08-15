import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TemplateEditor } from '@/components/comms/template-editor.tsx'
import { TranslationsPanel } from '@/components/comms/translations-panel.tsx'
import { actorCan, requirePermission } from '@/lib/auth/guard.ts'
import {
  approveTranslation,
  retireTemplate,
  saveTemplate,
  saveTranslation,
} from '@/lib/comms/template-actions.ts'
import { getTemplate } from '@/lib/comms/templates.ts'
import { previewTenancy, templateValues } from '@/lib/comms/template-values.ts'

export const metadata = { title: 'Template — Rental Operations' }

// NO `loading.tsx` HERE OR ABOVE. This page calls notFound() and a Suspense
// boundary above it would stream a 200 before the page ran (R-099).

export default async function TemplatePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  await requirePermission('template.write')

  const template = await getTemplate(id)
  if (!template) notFound()

  const [canApprove, sample] = await Promise.all([
    actorCan('template.approve'),
    previewTenancy(null),
  ])
  const values = sample ? await templateValues(sample) : null

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/messages/templates"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Message templates
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{template.name}</h1>
        <p className="text-muted-foreground text-sm">
          {template.kind === 'LEGAL' ? 'Legal notice' : 'Routine message'}
          {!template.active && ' · retired'}
        </p>
      </header>

      <TemplateEditor
        defaults={{
          name: template.name,
          kind: template.kind,
          subject: template.subject ?? '',
          body: template.body,
        }}
        sampleValues={values ?? {}}
        sampleLabel={sample?.tenantName ?? null}
        saveAction={saveTemplate.bind(null, template.id)}
      />

      <TranslationsPanel
        templateId={template.id}
        isLegal={template.kind === 'LEGAL'}
        canApprove={canApprove}
        translations={template.translations.map((translation) => ({
          id: translation.id,
          locale: translation.locale,
          subject: translation.subject,
          body: translation.body,
          approvedAt: translation.approvedAt ? translation.approvedAt.toISOString() : null,
          approvedByName: translation.approvedBy?.name ?? null,
        }))}
        saveAction={saveTranslation.bind(null, template.id)}
        approveAction={approveTranslation}
        retireAction={retireTemplate.bind(null, template.id)}
        active={template.active}
      />
    </div>
  )
}
