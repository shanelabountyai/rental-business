import Link from 'next/link'
import { TemplateEditor } from '@/components/comms/template-editor.tsx'
import { requirePermission } from '@/lib/auth/guard.ts'
import { saveTemplate } from '@/lib/comms/template-actions.ts'
import { previewTenancy, templateValues } from '@/lib/comms/template-values.ts'

export const metadata = { title: 'New template — Rental Operations' }

export default async function NewTemplatePage() {
  await requirePermission('template.write')

  // Resolved SERVER-SIDE, by the same function the send path uses. The editor
  // renders the preview in the browser as somebody types, but it never looks
  // anything up — it is handed the values.
  const sample = await previewTenancy(null)
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
        <h1 className="text-2xl font-semibold tracking-tight">New template</h1>
      </header>

      <TemplateEditor
        defaults={{ name: '', kind: 'ROUTINE', subject: '', body: '' }}
        sampleValues={values ?? {}}
        sampleLabel={sample?.tenantName ?? null}
        // Bound server-side. A plain function cannot cross this boundary and
        // `npm run build` does not catch the difference.
        saveAction={saveTemplate.bind(null, null)}
      />
    </div>
  )
}
