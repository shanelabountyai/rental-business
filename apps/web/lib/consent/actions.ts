'use server'

import { CONSENT_BASES, CONSENT_CHANNELS } from '@rental/core/consent'
import type { ConsentBasisName, ConsentChannelName } from '@rental/core/consent'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { requireTenant } from '@/lib/portal/guard.ts'

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
///
/// Exported: the same derivation authorizes the staff-side notification
/// mirror in lib/notifications/actions.ts. "Consent" in this file's name is
/// history, not scope - this helper answers "which property may staff edit
/// this tenant through", which is the same question for either table.
export async function propertyForTenant(tenantId: string) {
  const leaseTenant = await prisma.leaseTenant.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    select: { leaseId: true, lease: { select: { property: true } } },
  })
  return leaseTenant ? { property: leaseTenant.lease.property, leaseId: leaseTenant.leaseId } : null
}

export async function recordConsent(
  _previous: ConsentFormState,
  formData: FormData,
): Promise<ConsentFormState> {
  // From the form, not a bound argument - one action for every tenant on the
  // lease, the shape `endRecurringCharge` settled on. The authorisation is
  // derived FROM this id (the property is whichever one they hold a lease at,
  // and `tenant.write` is checked against that), so a forged value authorises
  // against its own tenant rather than against the one on screen.
  const tenantId = str(formData, 'tenantId')
  if (!tenantId) return { error: 'Choose which tenant consented.' }
  const found = await propertyForTenant(tenantId)
  if (!found) return { error: 'That tenant is not on a lease at any property you can see.' }
  const { property, leaseId } = found
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

  revalidatePath(`/leases/${leaseId}`)
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
  _previous: ConsentFormState,
  formData: FormData,
): Promise<ConsentFormState> {
  // From the form, for the same reason `recordConsent` reads its tenant that
  // way: one action serves every row in the list.
  const consentId = str(formData, 'consentId')
  if (!consentId) return { error: 'That consent record could not be found.' }
  const consent = await prisma.tenantConsent.findUniqueOrThrow({
    where: { id: consentId },
    select: { id: true, tenantId: true, channel: true, basis: true, revokedAt: true },
  })
  const found = await propertyForTenant(consent.tenantId)
  if (!found) return { error: 'That tenant is not on a lease at any property you can see.' }
  const { property, leaseId } = found
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

  revalidatePath(`/leases/${leaseId}`)
  return { notice: 'Consent withdrawn.' }
}

/**
 * A tenant withdrawing their OWN consent, from the portal (R-164).
 *
 * Same write and the same required-reason rule as `withdrawConsent` above -
 * a withdrawal with no stated reason is indistinguishable from a mistake
 * regardless of who presses the button. What differs is authorization: no
 * `tenant.write` check, because a tenant needs no permission to change their
 * own record - just proof the consent named is actually theirs, which
 * `findFirst({ where: { id, tenantId } })` establishes by construction rather
 * than by a comparison that could be gotten backwards.
 */
export async function withdrawOwnConsent(
  _previous: ConsentFormState,
  formData: FormData,
): Promise<ConsentFormState> {
  const tenant = await requireTenant()
  const consentId = str(formData, 'consentId')
  if (!consentId) return { error: 'That consent record could not be found.' }

  const consent = await prisma.tenantConsent.findFirst({
    where: { id: consentId, tenantId: tenant.id },
    select: { id: true, channel: true, basis: true, revokedAt: true },
  })
  if (!consent) return { error: 'That consent record could not be found.' }
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
        entityId: tenant.id,
        propertyId: null,
        reason,
        after: { consentId, channel: consent.channel, basis: consent.basis },
      },
      tx,
    )
  })

  revalidatePath('/portal/account')
  return { notice: 'Consent withdrawn.' }
}
