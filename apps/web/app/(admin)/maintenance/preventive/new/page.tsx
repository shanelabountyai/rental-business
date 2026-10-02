import { PreventiveTemplateForm } from '@/components/maintenance/preventive-template-form.tsx'
import { PageHeader } from '@/components/page-header.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { savePreventiveTemplate } from '@/lib/maintenance/preventive-actions.ts'

export const metadata = { title: 'New preventive-maintenance template — Rental Operations' }

export default async function NewPreventiveTemplatePage() {
  await requirePermission('workorder.write')

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <PageHeader title="New preventive-maintenance template" />
      <PreventiveTemplateForm action={savePreventiveTemplate.bind(null, null)} defaults={{}} />
    </div>
  )
}
