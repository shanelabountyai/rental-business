'use server'

import { canRecordSignature } from '@rental/core/inspections'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { requireTenantWithScope } from './guard.ts'

// The tenant's own e-sign (INSP-01, R-068 phase 2). Lives on the PORTAL
// side, with the portal's own guard - the actor is a tenant, and
// `requirePermission()` reads a staff session (verify-actions.ts's own
// header states the identical reasoning for the same wall).
//
// SIGNING AND LOCKING HAPPEN TOGETHER, deliberately unlike the staff path
// (`recordSignature`/`lockInspection` in lib/inspections/actions.ts, kept
// as two separate steps so a staff member reviewing evidence gets a
// checkpoint before finalizing). A tenant signing from the portal has
// already done their own review by definition - the form IS the review -
// so there is no second staff-side checkpoint to wait for; the report
// becomes immutable evidence in the same transaction as the signature.

export interface InspectionSignFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

export async function signInspectionAsTenant(
  inspectionId: string,
  _previous: InspectionSignFormState,
  formData: FormData,
): Promise<InspectionSignFormState> {
  const { scope } = await requireTenantWithScope()

  const inspection = await prisma.inspection.findUniqueOrThrow({ where: { id: inspectionId } })
  if (!inspection.leaseId || !scope.leaseIds.includes(inspection.leaseId)) {
    // "Not yours" reads the same as "does not exist" (DOC-03's own rule) -
    // no signal to a tenant probing an id that it belongs to someone else.
    return { error: 'That report could not be found.' }
  }

  const agreed = formData.get('agree') === 'on'
  if (!agreed) {
    return {
      error: 'Confirm the report is accurate before signing.',
      fieldErrors: { agree: 'Required.' },
    }
  }

  const decision = canRecordSignature({
    performedAt: inspection.performedAt,
    tenantSignedAt: inspection.tenantSignedAt,
    lockedAt: inspection.lockedAt,
  })
  if (!decision.allowed) return { error: decision.message }

  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.inspection.update({
      where: { id: inspectionId },
      data: { tenantSignedAt: now, lockedAt: now },
    })
    await audit(
      {
        action: 'inspection.signed',
        entityType: 'Inspection',
        entityId: inspectionId,
        propertyId: inspection.propertyId,
        after: { recordedBy: 'TENANT' },
      },
      tx,
    )
    await audit(
      {
        action: 'inspection.locked',
        entityType: 'Inspection',
        entityId: inspectionId,
        propertyId: inspection.propertyId,
        after: { signed: true },
      },
      tx,
    )
  })

  revalidatePath(`/portal/papers/inspections/${inspectionId}`)
  revalidatePath('/portal/papers')
  return { notice: 'Signed. This report is now final.' }
}
