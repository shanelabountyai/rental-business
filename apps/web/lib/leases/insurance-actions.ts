'use server'

import { createHash } from 'node:crypto'
import { parseLeaseDate } from '@rental/core/leases'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { generateStorageKey, storage } from '@/lib/storage/index.ts'

// Recording a tenant's renter's-insurance certificate (LEASE-10, R-067).
//
// A NEW ROW EVERY TIME, never an update - RenterInsurancePolicy.leaseId is
// deliberately not unique (see the model's own schema comment): an annual
// renewal is a new certificate with its own expiry, and overwriting the old
// row in place would erase the record of what was on file when it lapsed.

export interface InsuranceFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Records a policy, optionally with its certificate file attached. The file
 * is genuinely optional - carrier and dates recorded from a phone call are a
 * real, useful state distinct from "nothing on file at all", the same
 * "blank is a meaningful answer" posture `Lease.nsfFeeCents` already takes.
 *
 * Closes any open expiring/lapsed Task raised against the PREVIOUS policy on
 * this lease - a fresh certificate is the resolution those alerts existed to
 * produce, the same auto-close `offerRenewal` gives its own renewal Task.
 */
export async function recordRenterInsurance(
  leaseId: string,
  _previous: InsuranceFormState,
  formData: FormData,
): Promise<InsuranceFormState> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    include: { property: { select: { id: true, legalEntityId: true } } },
  })
  await requirePermission('lease.write', propertyResource(lease.property))

  const carrier = str(formData, 'carrier')
  if (!carrier) {
    return { error: 'Fix the highlighted fields.', fieldErrors: { carrier: 'Enter the carrier.' } }
  }
  const policyNumber = str(formData, 'policyNumber') || null
  const liabilityDollars = str(formData, 'liabilityDollars')
  const liabilityCents = liabilityDollars ? Math.round(Number(liabilityDollars) * 100) : null
  const expiresOnRaw = str(formData, 'expiresOn')
  const expiresOn = expiresOnRaw ? parseLeaseDate(expiresOnRaw) : null
  if (expiresOnRaw && !expiresOn) {
    return { error: 'Fix the highlighted fields.', fieldErrors: { expiresOn: 'That date could not be read.' } }
  }

  const file = formData.get('file')
  let documentId: string | null = null
  if (file instanceof File && file.size > 0) {
    const buffer = Buffer.from(await file.arrayBuffer())
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const storageKey = generateStorageKey(lease.propertyId, file.name)
    // Written before the row exists - same ordering documents/actions.ts's
    // own uploadDocument uses, and the same reasoning: a row that fails to
    // commit points at an orphaned file (cheap), never the reverse.
    await storage.put(storageKey, buffer, file.type || 'application/octet-stream')
    const document = await prisma.document.create({
      data: {
        propertyId: lease.propertyId,
        leaseId: lease.id,
        type: 'RENTER_INSURANCE_COI',
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        storageKey,
        sha256,
      },
    })
    documentId = document.id
  }

  const previousPolicy = await prisma.renterInsurancePolicy.findFirst({
    where: { leaseId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })

  await prisma.$transaction(async (tx) => {
    const created = await tx.renterInsurancePolicy.create({
      data: { leaseId, carrier, policyNumber, liabilityCents, expiresOn, documentId },
    })
    if (previousPolicy) {
      await tx.task.updateMany({
        where: {
          type: { in: ['renter_insurance_expiring', 'renter_insurance_lapsed'] },
          subjectId: previousPolicy.id,
          status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] },
        },
        data: { status: 'DONE' },
      })
    }
    await audit(
      {
        action: 'lease.renter_insurance_recorded',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        after: {
          policyId: created.id,
          carrier,
          expiresOn: expiresOn?.toISOString() ?? null,
          documentId,
        },
      },
      tx,
    )
  })

  revalidatePath(`/leases/${leaseId}`)
  return { notice: 'Recorded.' }
}
