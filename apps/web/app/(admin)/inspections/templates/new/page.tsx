import Link from 'next/link'
import { InspectionTemplateForm } from '@/components/inspections/inspection-template-form.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { saveInspectionTemplate } from '@/lib/inspections/template-actions.ts'

export const metadata = { title: 'New checklist — Rental Operations' }

export default async function NewInspectionTemplatePage() {
  await requirePermission('inspection.write')

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link
          href="/inspections/templates"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring w-fit text-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
        >
          ← Inspection checklists
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New checklist</h1>
      </header>

      {/* Bound server-side - a plain function cannot cross this boundary
          and npm run build does not catch the difference. */}
      <InspectionTemplateForm action={saveInspectionTemplate.bind(null, null)} />
    </div>
  )
}
