import Link from 'next/link'
import { requirePermission } from '@/lib/auth/guard.ts'
import { listInspectionTemplates } from '@/lib/inspections/template-queries.ts'

export const metadata = { title: 'Inspection checklists — Rental Operations' }

// The checklist template library (INSP-01, R-068) - the same shape
// /documents/templates gives its own library, one level over.

export default async function InspectionTemplatesPage() {
  await requirePermission('inspection.write')
  const templates = await listInspectionTemplates()

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Inspection checklists</h1>
        <p className="text-muted-foreground text-sm">
          Room-by-room lists you reuse across inspections. The same checklist walked
          at move-in and move-out is what makes the two comparable later.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <Link
          href="/inspections/templates/new"
          className="bg-foreground text-background min-h-11 w-fit rounded-md px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          New checklist
        </Link>

        {templates.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No checklists yet. Build one for your most common unit shape first.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {templates.map((template) => (
              <li key={template.id} className="rounded-lg border p-3">
                <Link
                  href={`/inspections/templates/${template.id}`}
                  className="focus-visible:ring-ring font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
                >
                  {template.name}
                </Link>
                <p className="text-muted-foreground mt-1 text-sm">
                  {(template.items as unknown as unknown[]).length} item
                  {(template.items as unknown as unknown[]).length === 1 ? '' : 's'}
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
