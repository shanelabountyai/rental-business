import { friendlyTimestamp } from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TemplateEditor } from '@/components/comms/template-editor.tsx'
import { TemplateHistoryPanel } from '@/components/comms/template-history-panel.tsx'
import { TranslationsPanel } from '@/components/comms/translations-panel.tsx'
import { PageHeader } from '@/components/page-header.tsx'
import { actorCan, propertyWhere, requireScope } from '@/lib/auth/guard.ts'
import {
  approveTranslation,
  duplicateTemplate,
  restoreTemplateVersion,
  retireTemplate,
  saveTemplate,
  saveTranslation,
} from '@/lib/comms/template-actions.ts'
import { getTemplate, listTemplateVersions } from '@/lib/comms/templates.ts'
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
  const { scope } = await requireScope('template.write')

  const template = await getTemplate(id)
  if (!template) notFound()

  const [canApprove, sample, versions, zoneProperty] = await Promise.all([
    actorCan('template.approve'),
    previewTenancy(null),
    listTemplateVersions(id),
    // No property owns a template, so no zone is exactly right: the first
    // property in scope, with the abbreviation printed, as the announcement
    // history page does (R-115).
    prisma.property.findFirst({
      where: propertyWhere(scope) ?? { id: '' },
      orderBy: { name: 'asc' },
      select: { timezone: true },
    }),
  ])
  const zone = zoneProperty?.timezone ?? 'UTC'
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
        <PageHeader title={template.name} />
        <p className="text-muted-foreground text-sm">
          {template.kind === 'LEGAL' ? 'Legal notice' : 'Routine message'}
          {!template.active && ' · retired'}
        </p>
      </header>

      <TemplateEditor
        // REMOUNTED ON A RESTORE AND ONLY THEN (R-264). The editor holds its
        // text in useState, so without this it keeps showing the pre-restore
        // words and the next Save quietly undoes the restore. Not keyed on
        // every version: an ordinary save would then remount the form and
        // throw away its own "Saved." live region (R-101).
        key={versions.find((row) => row.restoredFromVersion !== null)?.id ?? 'original'}
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

      <TemplateHistoryPanel
        versions={versions.map((row) => ({
          id: row.id,
          version: row.version,
          name: row.name,
          subject: row.subject,
          body: row.body,
          savedAt: friendlyTimestamp(row.createdAt, zone),
          savedByName: row.savedBy.name,
          restoredFromVersion: row.restoredFromVersion,
        }))}
        restoreAction={restoreTemplateVersion.bind(null, template.id)}
        duplicateAction={duplicateTemplate.bind(null, template.id)}
      />
    </div>
  )
}
