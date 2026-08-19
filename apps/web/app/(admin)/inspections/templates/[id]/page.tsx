import Link from 'next/link'
import { notFound } from 'next/navigation'
import { InspectionTemplateForm } from '@/components/inspections/inspection-template-form.tsx'
import { RetireInspectionTemplateForm } from '@/components/inspections/retire-inspection-template-form.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { retireInspectionTemplate, saveInspectionTemplate } from '@/lib/inspections/template-actions.ts'
import { getInspectionTemplate } from '@/lib/inspections/template-queries.ts'

export const metadata = { title: 'Inspection checklist — Rental Operations' }

// NO `loading.tsx` HERE OR ABOVE. This page calls notFound() and a Suspense
// boundary above it would stream a 200 before the page ran (R-099).

export default async function InspectionTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  await requirePermission('inspection.write')

  const template = await getInspectionTemplate(id)
  if (!template) notFound()

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/inspections/templates"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Inspection checklists
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{template.name}</h1>
        {!template.active && <p className="text-muted-foreground text-sm">Retired</p>}
      </header>

      <InspectionTemplateForm
        action={saveInspectionTemplate.bind(null, template.id)}
        defaultName={template.name}
        defaultItems={template.items as unknown as { room: string; item: string }[]}
      />

      <RetireInspectionTemplateForm
        action={retireInspectionTemplate.bind(null, template.id)}
        active={template.active}
      />
    </div>
  )
}
