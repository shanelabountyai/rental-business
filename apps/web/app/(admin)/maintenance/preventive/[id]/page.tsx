import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PreventiveTemplateForm } from '@/components/maintenance/preventive-template-form.tsx'
import { TaskActionButton } from '@/components/tasks/action-button.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { deactivatePreventiveTemplate, savePreventiveTemplate } from '@/lib/maintenance/preventive-actions.ts'
import { getPreventiveTemplate } from '@/lib/maintenance/preventive-queries.ts'

export const metadata = { title: 'Preventive-maintenance template — Rental Operations' }

// NO `loading.tsx` HERE OR ABOVE (R-099): this page calls notFound().
export default async function PreventiveTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requirePermission('workorder.write')
  const template = await getPreventiveTemplate(id)
  if (!template) notFound()

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <Link
        href="/maintenance/preventive"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
      >
        ← Preventive maintenance
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">{template.name}</h1>

      <PreventiveTemplateForm
        action={savePreventiveTemplate.bind(null, template.id)}
        defaults={{
          name: template.name,
          trade: template.trade ?? '',
          intervalMonths: template.intervalMonths,
        }}
      />

      {template.active && (
        <TaskActionButton action={deactivatePreventiveTemplate.bind(null, template.id)} label="Deactivate" />
      )}
    </div>
  )
}
