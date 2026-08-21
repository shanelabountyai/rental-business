'use server'

import { isVendorPaymentMethod, validateVendorRecord } from '@rental/core/vendors'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'

// Writes for vendor records themselves (MAINT-11, R-079) - what a PM types
// managing the vendor list. `vendor.write`, no resource: `Vendor` carries
// no `propertyId` (it is portfolio-wide, the same posture `JurisdictionRule`
// already takes), so there is no property/entity scope to check it against.

export interface VendorFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function csv(formData: FormData, name: string): string[] {
  return str(formData, name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/// Creates a new vendor when `vendorId` is null, otherwise updates the
/// existing one - one form, one action, the same "figure out which by
/// whether an id was bound" shape this codebase already uses elsewhere.
export async function saveVendorRecord(
  vendorId: string | null,
  _previous: VendorFormState,
  formData: FormData,
): Promise<VendorFormState> {
  const actor = await requirePermission('vendor.write')

  const input = {
    name: str(formData, 'name'),
    trades: csv(formData, 'trades').map((t) => t.toLowerCase()),
    contactName: str(formData, 'contactName') || null,
    email: str(formData, 'email') || null,
    phone: str(formData, 'phone') || null,
    serviceAreas: csv(formData, 'serviceAreas'),
    licenseNumber: str(formData, 'licenseNumber') || null,
    w9OnFile: formData.get('w9OnFile') === 'on',
    coiExpiresOn: str(formData, 'coiExpiresOn') || null,
    preferredRank: str(formData, 'preferredRank') ? Number(str(formData, 'preferredRank')) : null,
    emergencyAvailable: formData.get('emergencyAvailable') === 'on',
  }
  const violations = validateVendorRecord(input)
  if (violations.length > 0) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
    }
  }

  const data = {
    name: input.name,
    trades: input.trades,
    contactName: input.contactName,
    email: input.email,
    phone: input.phone,
    serviceAreas: input.serviceAreas,
    licenseNumber: input.licenseNumber,
    w9OnFile: input.w9OnFile,
    coiExpiresOn: input.coiExpiresOn ? new Date(`${input.coiExpiresOn}T00:00:00.000Z`) : null,
    preferredRank: input.preferredRank,
    emergencyAvailable: input.emergencyAvailable,
  }

  const vendor = await prisma.$transaction(async (tx) => {
    const saved = vendorId
      ? await tx.vendor.update({ where: { id: vendorId }, data })
      : await tx.vendor.create({ data })
    await audit(
      {
        action: 'vendor.record_saved',
        entityType: 'Vendor',
        entityId: saved.id,
        after: { ...data, coiExpiresOn: input.coiExpiresOn, byStaffId: actor.id },
      },
      tx,
    )
    return saved
  })

  revalidatePath('/vendors')
  revalidatePath(`/vendors/${vendor.id}`)
  redirect(`/vendors/${vendor.id}`)
}

/// Deactivates a vendor rather than deleting it - `WorkOrder.vendorId` and
/// every other reference stays valid, the same "retire, never delete"
/// posture this product takes everywhere a record has real history behind
/// it.
export async function deactivateVendor(vendorId: string): Promise<VendorFormState> {
  await requirePermission('vendor.write')
  await prisma.vendor.update({ where: { id: vendorId }, data: { active: false } })
  revalidatePath('/vendors')
  revalidatePath(`/vendors/${vendorId}`)
  return { notice: 'Deactivated.' }
}

export async function markInvoicePaid(
  workOrderId: string,
  _previous: VendorFormState,
  formData: FormData,
): Promise<VendorFormState> {
  const actor = await requirePermission('vendor.write')

  const method = str(formData, 'invoicePaymentMethod')
  if (!isVendorPaymentMethod(method)) {
    return {
      error: 'Fix the highlighted fields.',
      fieldErrors: { invoicePaymentMethod: 'Choose how the vendor was paid.' },
    }
  }

  const workOrder = await prisma.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    select: { id: true, propertyId: true, invoiceCents: true, invoicePaidAt: true },
  })
  if (workOrder.invoiceCents == null) {
    return { error: 'There is no invoice on file for this job yet.' }
  }
  if (workOrder.invoicePaidAt) {
    return { error: 'Already marked paid.' }
  }

  await prisma.$transaction(async (tx) => {
    await tx.workOrder.update({
      where: { id: workOrderId },
      data: { invoicePaidAt: new Date(), invoicePaymentMethod: method },
    })
    await audit(
      {
        action: 'workorder.invoice_paid',
        entityType: 'WorkOrder',
        entityId: workOrderId,
        propertyId: workOrder.propertyId,
        after: { invoiceCents: workOrder.invoiceCents, method, byStaffId: actor.id },
      },
      tx,
    )
  })

  revalidatePath(`/workorders/${workOrderId}`)
  return { notice: 'Marked paid.' }
}
