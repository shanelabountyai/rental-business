'use server'

import { createHash } from 'node:crypto'
import { balanceCents, computeDisposition, dispositionLetterText } from '@rental/core/ledger'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Writes for deposit disposition (INSP-03, R-071).
//
// `ledger.adjust`, not `lease.write` - a deduction against money held on
// trust is exactly as forgeable as an offline payment, and
// `recordOfflinePayment`'s own comment already makes this call for the
// identical reason: there is no processor on the other side to disagree.
//
// EDITABLE UNTIL FINALIZED. `Deposit.dispositionSentAt` is the lock -
// checked here, in the action layer, the same posture `canEditItem` takes
// against `Inspection.lockedAt` rather than a database trigger, because
// this is a draft staff builds up before committing to a letter.

export interface DepositFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function optionalInt(formData: FormData, name: string): number | null {
  const raw = str(formData, name)
  return raw ? Math.round(Number(raw)) : null
}

async function depositForWrite(depositId: string) {
  const deposit = await prisma.deposit.findUniqueOrThrow({
    where: { id: depositId },
    select: {
      id: true,
      propertyId: true,
      leaseId: true,
      dispositionSentAt: true,
      property: { select: { id: true, legalEntityId: true } },
    },
  })
  const actor = await requirePermission('ledger.adjust', propertyResource(deposit.property))
  return { deposit, actor }
}

export async function addDeduction(
  depositId: string,
  _previous: DepositFormState,
  formData: FormData,
): Promise<DepositFormState> {
  const { deposit, actor } = await depositForWrite(depositId)
  if (deposit.dispositionSentAt) {
    return { error: 'This disposition has already been finalized.' }
  }

  const description = str(formData, 'description')
  const dollars = str(formData, 'amountDollars')
  const amountCents = dollars ? Math.round(Number(dollars) * 100) : Number.NaN
  const workOrderId = str(formData, 'workOrderId') || null
  const inspectionItemId = str(formData, 'inspectionItemId') || null
  const estimatedAgeYears = optionalInt(formData, 'estimatedAgeYears')
  const usefulLifeYears = optionalInt(formData, 'usefulLifeYears')

  const fieldErrors: Record<string, string> = {}
  if (!description) fieldErrors.description = 'Describe the deduction.'
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    fieldErrors.amountDollars = 'Enter how much to deduct.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Fix the highlighted fields.', fieldErrors }
  }

  await prisma.$transaction(async (tx) => {
    const deduction = await tx.depositDeduction.create({
      data: {
        propertyId: deposit.propertyId,
        depositId: deposit.id,
        description,
        amountCents,
        workOrderId,
        inspectionItemId,
        estimatedAgeYears,
        usefulLifeYears,
        createdByStaffId: actor.id,
      },
    })

    const file = formData.get('file')
    if (file instanceof File && file.size > 0) {
      const buffer = Buffer.from(await file.arrayBuffer())
      const contentType = file.type || 'application/octet-stream'
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      const storageKey = generateStorageKey(deposit.propertyId, file.name)
      await storage.put(storageKey, buffer, contentType)
      await tx.document.create({
        data: {
          propertyId: deposit.propertyId,
          leaseId: deposit.leaseId,
          depositDeductionId: deduction.id,
          type: 'INVOICE',
          fileName: file.name,
          contentType,
          sizeBytes: file.size,
          storageKey,
          sha256,
          uploadedByStaffId: actor.id,
        },
      })
    }

    await audit(
      {
        action: 'deposit.deduction_added',
        entityType: 'Deposit',
        entityId: deposit.id,
        propertyId: deposit.propertyId,
        after: { description, amountCents, workOrderId, inspectionItemId },
      },
      tx,
    )
  })

  revalidatePath(`/leases/${deposit.leaseId}/deposit`)
  return { notice: 'Deduction added.' }
}

export async function removeDeduction(deductionId: string): Promise<DepositFormState> {
  const deduction = await prisma.depositDeduction.findUniqueOrThrow({
    where: { id: deductionId },
    select: {
      id: true,
      description: true,
      amountCents: true,
      deposit: {
        select: {
          id: true,
          leaseId: true,
          propertyId: true,
          dispositionSentAt: true,
          property: { select: { id: true, legalEntityId: true } },
        },
      },
    },
  })
  await requirePermission('ledger.adjust', propertyResource(deduction.deposit.property))
  if (deduction.deposit.dispositionSentAt) {
    return { error: 'This disposition has already been finalized.' }
  }

  await prisma.$transaction(async (tx) => {
    // Evidence documents are not deleted - they lose their
    // `depositDeductionId` link (the FK's own `ON DELETE SET NULL`) and
    // stay on file under the lease, the same "retire the pointer, keep the
    // record" posture DOC-05 already takes.
    await tx.depositDeduction.delete({ where: { id: deductionId } })
    await audit(
      {
        action: 'deposit.deduction_removed',
        entityType: 'Deposit',
        entityId: deduction.deposit.id,
        propertyId: deduction.deposit.propertyId,
        after: { description: deduction.description, amountCents: deduction.amountCents },
      },
      tx,
    )
  })

  revalidatePath(`/leases/${deduction.deposit.leaseId}/deposit`)
  return { notice: 'Removed.' }
}

/**
 * Locks the deduction list, computes the final totals, and creates the
 * disposition letter as a real `Notice` (DEPOSIT_DISPOSITION) - from here,
 * generating the PDF and recording its service to the forwarding address is
 * R-051's existing `/notices/[id]` page, unmodified.
 */
export async function finalizeDisposition(
  depositId: string,
  _previous: DepositFormState,
  formData: FormData,
): Promise<DepositFormState> {
  const deposit = await prisma.deposit.findUniqueOrThrow({
    where: { id: depositId },
    select: {
      id: true,
      propertyId: true,
      leaseId: true,
      heldCents: true,
      dispositionSentAt: true,
      forwardingAddress: true,
      property: { select: { id: true, legalEntityId: true, addressLine1: true, timezone: true } },
      lease: {
        select: {
          id: true,
          moveOutAt: true,
          unit: { select: { name: true } },
          leaseTenants: {
            where: { isPrimary: true },
            take: 1,
            select: { tenant: { select: { firstName: true, lastName: true } } },
          },
        },
      },
      deductions: { select: { id: true, description: true, amountCents: true } },
    },
  })
  await requirePermission('ledger.adjust', propertyResource(deposit.property))
  if (deposit.dispositionSentAt) return { error: 'This disposition has already been finalized.' }
  if (!deposit.lease.moveOutAt) {
    return { error: 'No move-out date is on record for this tenancy yet.' }
  }
  // The form's own checkbox is `required`, so this only fires for a submit
  // that did not come from it. It stays because the browser check is a
  // convenience and this is the gate (R-116).
  if (!formData.get('acknowledgeFinal')) {
    return { error: 'Confirm you understand the letter cannot be undone.' }
  }

  const forwardingAddress = str(formData, 'forwardingAddress') || deposit.forwardingAddress
  if (!forwardingAddress) {
    return {
      error: 'A forwarding address is required to send the disposition letter.',
      fieldErrors: { forwardingAddress: 'Required.' },
    }
  }

  const ledgerRows = await prisma.ledgerEntry.findMany({
    where: { leaseId: deposit.leaseId },
    select: { id: true, type: true, amountCents: true, occurredAt: true, description: true },
  })
  const deductedCents = deposit.deductions.reduce((sum, d) => sum + d.amountCents, 0)
  const totals = computeDisposition(deposit.heldCents, deductedCents, balanceCents(ledgerRows))

  const primaryTenant = deposit.lease.leaseTenants[0]?.tenant
  const tenantName = primaryTenant ? `${primaryTenant.firstName} ${primaryTenant.lastName}` : 'Tenant'
  const bodyText = dispositionLetterText({
    tenantName,
    addressLine1: deposit.property.addressLine1,
    unitName: deposit.lease.unit.name,
    timezone: deposit.property.timezone,
    moveOutOn: deposit.lease.moveOutAt,
    deductions: deposit.deductions,
    totals,
  })

  const notice = await prisma.$transaction(async (tx) => {
    const created = await tx.notice.create({
      data: {
        propertyId: deposit.propertyId,
        leaseId: deposit.leaseId,
        type: 'DEPOSIT_DISPOSITION',
        addressOfRecord: forwardingAddress,
        bodyText,
      },
    })
    await tx.deposit.update({
      where: { id: deposit.id },
      data: {
        noticeId: created.id,
        dispositionSentAt: new Date(),
        forwardingAddress,
        appliedCents: totals.appliedCents,
        refundedCents: totals.refundedCents,
      },
    })
    await audit(
      {
        action: 'deposit.disposition_finalized',
        entityType: 'Deposit',
        entityId: deposit.id,
        propertyId: deposit.propertyId,
        after: { noticeId: created.id, ...totals },
      },
      tx,
    )
    return created
  })

  revalidatePath(`/leases/${deposit.leaseId}/deposit`)
  redirect(`/notices/${notice.id}`)
}
