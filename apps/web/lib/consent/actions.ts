'use server'

import { CONSENT_BASES, CONSENT_CHANNELS } from '@rental/core/consent'
import type { ConsentBasisName, ConsentChannelName } from '@rental/core/consent'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'

// Recording and withdrawing TCPA consent (COMM-02, R-051b).
//
// GATED ON `tenant.write`, not on `message.send`. Recording that somebody
// agreed to be contacted is a change to their record, not an act of
// contacting them - and the person who should be able to send a rent reminder
// is not automatically the person who should be able to assert what a tenant
// agreed to.

export interface ConsentFormState {
  error?: string
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/// The property a tenant's consent is authorised against: any property they
/// hold a lease at. A tenant with no lease at all has no property to scope
/// the check to, so there is nobody who may edit them - which is the correct
/// refusal rather than an oversight.
async function propertyForTenant(tenantId: string) {
  const leaseTenant = await prisma.leaseTenant.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    select: { lease: { select: { property: true } } },
  })
  return leaseTenant?.lease.property ?? null
}

export async function recordConsent(
  tenantId: string,
  _previous: ConsentFormState,
  formData: FormData,
): Promise<ConsentFormState> {
  const property = await propertyForTenant(tenantId)
  if (!property) return { error: 'That tenant is not on a lease at any property you can see.' }
  const actor = await requirePermission('tenant.write', propertyResource(property))

  const channel = str(formData, 'channel') as ConsentChannelName
  const basis = str(formData, 'basis') as ConsentBasisName
  if (!(CONSENT_CHANNELS as readonly string[]).includes(channel)) {
    return { error: 'Choose a channel.' }
  }
  if (!(CONSENT_BASES as readonly string[]).includes(basis)) {
    return { error: 'Choose how consent was obtained.' }
  }

  const disclosureText = str(formData, 'disclosureText') || null
  const note = str(formData, 'note') || null

  // The CHECK constraint enforces this too; refusing here means the operator
  // gets a sentence rather than a constraint violation. EXPRESS_WRITTEN is the
  // basis that unlocks marketing, so it is the one that has to be able to
  // show what was agreed to.
  if (basis === 'EXPRESS_WRITTEN' && !disclosureText) {
    return {
      error:
        'Express written consent needs the wording the tenant agreed to. Paste it, or choose a different basis.',
    }
  }

  await prisma.$transaction(async (tx) => {
    const consent = await tx.tenantConsent.create({
      data: {
        tenantId,
        channel,
        basis,
        source: 'STAFF_RECORDED',
        disclosureText,
        note,
        recordedByStaffId: actor.id,
      },
    })
    await audit(
      {
        action: 'consent.recorded',
        entityType: 'Tenant',
        entityId: tenantId,
        propertyId: property.id,
        after: { consentId: consent.id, channel, basis, hasDisclosure: disclosureText != null },
      },
      tx,
    )
  })

  revalidatePath('/leases')
  return { notice: 'Consent recorded.' }
}

/**
 * Withdraws one consent record.
 *
 * A REASON IS REQUIRED. "Why did we stop being allowed to text them" is the
 * question a TCPA claim turns on, and a withdrawal with no stated reason is
 * indistinguishable from a mistake somebody made in the UI.
 *
 * Write-once at the database: withdrawing twice is refused by the trigger.
 * Re-consenting later is a new row, so the history of a permission given,
 * taken back and given again survives intact.
 */
export async function withdrawConsent(
  consentId: string,
  _previous: ConsentFormState,
  formData: FormData,
): Promise<ConsentFormState> {
  const consent = await prisma.tenantConsent.findUniqueOrThrow({
    where: { id: consentId },
    select: { id: true, tenantId: true, channel: true, basis: true, revokedAt: true },
  })
  const property = await propertyForTenant(consent.tenantId)
  if (!property) return { error: 'That tenant is not on a lease at any property you can see.' }
  await requirePermission('tenant.write', propertyResource(property))

  if (consent.revokedAt) return { error: 'That consent has already been withdrawn.' }

  const reason = str(formData, 'revokeReason')
  if (!reason) return { error: 'Say why the consent is being withdrawn.' }

  await prisma.$transaction(async (tx) => {
    await tx.tenantConsent.update({
      where: { id: consentId },
      data: { revokedAt: new Date(), revokeReason: reason },
    })
    await audit(
      {
        action: 'consent.withdrawn',
        entityType: 'Tenant',
        entityId: consent.tenantId,
        propertyId: property.id,
        reason,
        after: { consentId, channel: consent.channel, basis: consent.basis },
      },
      tx,
    )
  })

  revalidatePath('/leases')
  return { notice: 'Consent withdrawn.' }
}
