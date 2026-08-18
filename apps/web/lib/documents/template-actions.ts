'use server'

import { validateDocumentTemplate } from '@rental/core/documents'
import { unknownLeaseMergeFields } from '@rental/core/leases'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'

// Writing document templates (DOC-04, R-062) - the same PORTFOLIO-WIDE,
// no-resource `template.write` check `comms/template-actions.ts` already
// uses for the identical reason: a template is not owned by one property.

export interface DocumentTemplateFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

export async function saveDocumentTemplate(
  templateId: string | null,
  _previous: DocumentTemplateFormState,
  formData: FormData,
): Promise<DocumentTemplateFormState> {
  const actor = await requirePermission('template.write')

  const input = {
    name: str(formData, 'name'),
    documentType: str(formData, 'documentType'),
    body: str(formData, 'body'),
    // R-063: per-state selection, and which addendum this is when the
    // documentType is ADDENDUM. Blank means "the default, any state" / "not
    // an addendum" - see DocumentTemplate.state/addendumKey's own comments.
    state: str(formData, 'state') || null,
    addendumKey: str(formData, 'addendumKey') || null,
  }

  // VALIDATED HERE, THE LAST MOMENT A HUMAN IS PRESENT - saveTemplate's own
  // reasoning: a typo'd merge field that reaches generation goes out wrong
  // on the actual PDF, not in a preview somebody was still looking at.
  const violations = validateDocumentTemplate(input)
  // A LEASE/ADDENDUM template's merge fields are checked against
  // `@rental/core/leases`' own LEASE_MERGE_FIELDS catalogue here, not inside
  // `validateDocumentTemplate` - see that function's own comment for the
  // import-cycle reason the check could not live there.
  if (input.documentType === 'LEASE' || input.documentType === 'ADDENDUM') {
    const unknown = unknownLeaseMergeFields(input.body)
    if (unknown.length > 0) {
      violations.push({
        field: 'body',
        message: `Not a merge field: ${[...new Set(unknown)].map((k) => `{{${k}}}`).join(', ')}. Pick from the list.`,
      })
    }
  }
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  const existing = templateId
    ? await prisma.documentTemplate.findUnique({
        where: { id: templateId },
        select: { name: true, documentType: true, body: true, state: true, addendumKey: true },
      })
    : null
  if (templateId && !existing) return { error: 'That template no longer exists.' }

  let savedId = templateId
  await prisma.$transaction(async (tx) => {
    const saved = templateId
      ? await tx.documentTemplate.update({
          where: { id: templateId },
          data: { ...input, updatedByStaffId: actor.id },
        })
      : await tx.documentTemplate.create({
          data: { ...input, createdByStaffId: actor.id },
        })
    savedId = saved.id

    await audit(
      {
        action: 'template.saved',
        entityType: 'DocumentTemplate',
        entityId: saved.id,
        // BOTH SNAPSHOTS - a document GENERATED from this template is
        // evidence, and the template it came from is part of explaining it
        // (saveTemplate's own reasoning for MessageTemplate, restated).
        before: existing ?? undefined,
        after: input,
      },
      tx,
    )
  })

  revalidatePath('/documents/templates')
  if (!templateId) redirect(`/documents/templates/${savedId}`)
  return { notice: 'Saved.' }
}

export async function retireDocumentTemplate(
  templateId: string,
  _previous: DocumentTemplateFormState,
  _formData: FormData,
): Promise<DocumentTemplateFormState> {
  const actor = await requirePermission('template.write')

  const existing = await prisma.documentTemplate.findUnique({
    where: { id: templateId },
    select: { active: true },
  })
  if (!existing) return { error: 'That template no longer exists.' }

  await prisma.$transaction(async (tx) => {
    await tx.documentTemplate.update({
      where: { id: templateId },
      // RETIRED, NOT DELETED - retireTemplate's own reasoning: a document
      // generated from this template is evidence.
      data: { active: !existing.active, updatedByStaffId: actor.id },
    })
    await audit(
      {
        action: 'template.saved',
        entityType: 'DocumentTemplate',
        entityId: templateId,
        before: { active: existing.active },
        after: { active: !existing.active },
      },
      tx,
    )
  })

  revalidatePath('/documents/templates')
  revalidatePath(`/documents/templates/${templateId}`)
  return { notice: existing.active ? 'Retired.' : 'Back in use.' }
}
