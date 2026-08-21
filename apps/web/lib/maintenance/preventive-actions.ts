'use server'

import { fallbackVendorsForTrade, vendorCoversProperty } from '@rental/core/vendors'
import { validatePreventiveTemplate } from '@rental/core/workorders'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { dueUnitsForTemplate } from '@/lib/maintenance/preventive-queries.ts'

// Writes for preventive-maintenance batch templates (MAINT-08, R-080).
// `workorder.write`, no resource, the same coarse-permission-then-scope
// shape the work-order list page already uses: any actor who may write work
// orders may manage these templates and run a batch, and the actual reach of
// "run" is bounded by `currentScope()` below, same as every other work-order
// query in this product.

export interface PreventiveFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

export async function savePreventiveTemplate(
  templateId: string | null,
  _previous: PreventiveFormState,
  formData: FormData,
): Promise<PreventiveFormState> {
  const actor = await requirePermission('workorder.write')

  const input = {
    name: str(formData, 'name'),
    trade: str(formData, 'trade').toLowerCase() || null,
    intervalMonths: Number(str(formData, 'intervalMonths')),
  }
  const violations = validatePreventiveTemplate(input)
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  await prisma.$transaction(async (tx) => {
    const saved = templateId
      ? await tx.preventiveMaintenanceTemplate.update({ where: { id: templateId }, data: input })
      : await tx.preventiveMaintenanceTemplate.create({
          data: { ...input, createdByStaffId: actor.id },
        })
    await audit(
      { action: 'preventive.template_saved', entityType: 'PreventiveMaintenanceTemplate', entityId: saved.id, after: input },
      tx,
    )
  })

  revalidatePath('/maintenance/preventive')
  redirect('/maintenance/preventive')
}

export async function deactivatePreventiveTemplate(templateId: string): Promise<PreventiveFormState> {
  await requirePermission('workorder.write')
  await prisma.preventiveMaintenanceTemplate.update({ where: { id: templateId }, data: { active: false } })
  revalidatePath('/maintenance/preventive')
  return { notice: 'Deactivated.' }
}

/**
 * "One action creates the batch across properties" (MAINT-08). Every unit
 * in the actor's own scope that is due gets one new SUBMITTED work order,
 * auto-assigned to a vendor when exactly the actor's territory/trade match
 * finds one - unmatched units stay unassigned, same as any other new work
 * order, for a PM to assign by hand from the existing picker.
 */
export async function runPreventiveBatch(
  templateId: string,
  _previous: PreventiveFormState,
  _formData: FormData,
): Promise<PreventiveFormState> {
  const actor = await requirePermission('workorder.write')

  const template = await prisma.preventiveMaintenanceTemplate.findUnique({ where: { id: templateId } })
  if (!template || !template.active) return { error: 'This template is no longer active.' }

  const scope = await currentScope(actor)
  const due = await dueUnitsForTemplate(templateId, template, scope)
  if (due.length === 0) return { notice: 'Nothing due right now.' }

  const vendors = await prisma.vendor.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      trades: true,
      preferredRank: true,
      active: true,
      w9OnFile: true,
      coiExpiresOn: true,
      serviceAreas: true,
    },
  })

  let autoAssigned = 0
  for (const unit of due) {
    const inTerritory = vendors.filter((v) =>
      vendorCoversProperty(v, { city: unit.propertyCity, postalCode: unit.propertyPostalCode }),
    )
    const ranked = fallbackVendorsForTrade(inTerritory, template.trade, new Date())
    const vendorId = ranked[0]?.id ?? null
    if (vendorId) autoAssigned++

    await prisma.$transaction(async (tx) => {
      const created = await tx.workOrder.create({
        data: {
          propertyId: unit.propertyId,
          unitId: unit.unitId,
          scope: template.name,
          priority: 'ROUTINE',
          pmTemplateId: template.id,
          vendorId,
        },
      })
      await audit(
        {
          action: 'workorder.created',
          entityType: 'WorkOrder',
          entityId: created.id,
          propertyId: unit.propertyId,
          after: { scope: created.scope, pmTemplateId: template.id, vendorId },
        },
        tx,
      )
    })
  }

  revalidatePath('/workorders')
  revalidatePath('/maintenance/preventive')
  return {
    notice: `Created ${due.length} work order${due.length === 1 ? '' : 's'} — ${autoAssigned} auto-assigned by territory, ${due.length - autoAssigned} left for you to assign.`,
  }
}
