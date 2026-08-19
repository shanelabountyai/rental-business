'use server'

import { validateInspectionTemplate } from '@rental/core/inspections'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'

// Writing inspection checklist templates (INSP-01, R-068) - the same
// PORTFOLIO-WIDE, no-resource `inspection.write` check
// documents/template-actions.ts already uses for DocumentTemplate, for the
// identical reason: a checklist is not owned by one property.

export interface InspectionTemplateFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/// `room[]`/`item[]` arrive as two parallel arrays, one pair of inputs per
/// checklist row - FormData preserves DOM order, so zipping by index
/// reconstructs the rows without inventing a row id the form has no other
/// use for. A wholly blank row (the form's own fixed spare-row slots,
/// InspectionTemplateForm's own comment on why they exist) is dropped
/// rather than validated - a slot nobody used is not a checklist item with
/// a missing name, it is simply unused.
function readChecklistItems(formData: FormData): { room: string; item: string }[] {
  const rooms = formData.getAll('room').map(String)
  const items = formData.getAll('item').map(String)
  return rooms
    .map((room, index) => ({ room: room.trim(), item: (items[index] ?? '').trim() }))
    .filter((row) => row.room !== '' || row.item !== '')
}

export async function saveInspectionTemplate(
  templateId: string | null,
  _previous: InspectionTemplateFormState,
  formData: FormData,
): Promise<InspectionTemplateFormState> {
  const actor = await requirePermission('inspection.write')

  const input = {
    name: str(formData, 'name'),
    items: readChecklistItems(formData),
  }

  const violations = validateInspectionTemplate(input)
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  const existing = templateId
    ? await prisma.inspectionTemplate.findUnique({ where: { id: templateId }, select: { name: true, items: true } })
    : null
  if (templateId && !existing) return { error: 'That checklist no longer exists.' }

  let savedId = templateId
  await prisma.$transaction(async (tx) => {
    const saved = templateId
      ? await tx.inspectionTemplate.update({
          where: { id: templateId },
          data: { name: input.name, items: input.items, updatedByStaffId: actor.id },
        })
      : await tx.inspectionTemplate.create({
          data: { name: input.name, items: input.items, createdByStaffId: actor.id },
        })
    savedId = saved.id

    await audit(
      {
        action: 'template.saved',
        entityType: 'InspectionTemplate',
        entityId: saved.id,
        before: existing ?? undefined,
        after: input,
      },
      tx,
    )
  })

  revalidatePath('/inspections/templates')
  if (!templateId) redirect(`/inspections/templates/${savedId}`)
  return { notice: 'Saved.' }
}

export async function retireInspectionTemplate(
  templateId: string,
  _previous: InspectionTemplateFormState,
  _formData: FormData,
): Promise<InspectionTemplateFormState> {
  const actor = await requirePermission('inspection.write')

  const existing = await prisma.inspectionTemplate.findUnique({
    where: { id: templateId },
    select: { active: true },
  })
  if (!existing) return { error: 'That checklist no longer exists.' }

  await prisma.$transaction(async (tx) => {
    await tx.inspectionTemplate.update({
      where: { id: templateId },
      // RETIRED, NOT DELETED - an inspection already built from this
      // template keeps its own copied items regardless (Inspection.templateId's
      // own comment: provenance, not a live link), the same reasoning
      // DocumentTemplate.active already gives.
      data: { active: !existing.active, updatedByStaffId: actor.id },
    })
    await audit(
      {
        action: 'template.saved',
        entityType: 'InspectionTemplate',
        entityId: templateId,
        before: { active: existing.active },
        after: { active: !existing.active },
      },
      tx,
    )
  })

  revalidatePath('/inspections/templates')
  revalidatePath(`/inspections/templates/${templateId}`)
  return { notice: existing.active ? 'Retired.' : 'Back in use.' }
}
