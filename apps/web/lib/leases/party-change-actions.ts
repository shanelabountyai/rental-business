'use server'

import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { esignAdapter } from '@/lib/esign/provider.ts'
import {
  buildPartyChange,
  loadLeaseForPartyChange,
  type PartyChangeFormState,
} from '@/lib/leases/party-change-builder.ts'

// Starting and withdrawing a change of who is on a live lease (RISK-10,
// R-090). Same shape as `esign-staff-actions.ts`, which it is deliberately a
// sibling of rather than an extension: `lease.execute` first, a transaction
// pairing each write with its audit entry, and every provider call outside
// any transaction.
//
// REUSES R-063'S ENTIRE SIGNING CEREMONY. `LeaseEnvelope.kind = AMENDMENT`
// is the only new machinery - the per-signer tokens, the /sign/[token] page,
// the typed-name ceremony, the completion certificate and the executed PDF
// are all R-063's, unchanged. Writing a second envelope model for a document
// that needs identical handling would have doubled the surface for no
// evidence gained.
//
// THE CHANGE IS APPLIED WHEN THE LAST SIGNATURE LANDS, never on a timer,
// even though `effectiveOn` may be weeks out. A scheduled cutover (which
// R-065's renewals do have) would take a departing roommate's portal access
// and stop their notices on a date arrived at by a job - and while they are
// very possibly still living there. What the effective date actually governs
// is the release, which is a matter of what the signed document says; see
// RELEASE_IS_PROSPECTIVE. The consequence is stated plainly on the panel.

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function all(formData: FormData, name: string): string[] {
  return formData.getAll(name).filter((v): v is string => typeof v === 'string' && v !== '')
}

/**
 * Sends the amendment that changes who is on this lease.
 *
 * ONE ACTION, NOT A DRAFT-THEN-SEND PAIR. There is nothing to review between
 * the two: the document is generated from the form that was just filled in,
 * and a half-built change nobody has been asked to sign is a decision
 * somebody is still making, not a record worth a row.
 */
export async function startPartyChange(
  leaseId: string,
  _previous: PartyChangeFormState,
  formData: FormData,
): Promise<PartyChangeFormState> {
  const { lease, actor } = await loadLeaseForPartyChange(leaseId)

  // The form speaks in LeaseTenant rows because that is what the panel
  // renders; the builder speaks in Tenant ids because the other entry point
  // only ever has one of those.
  const outgoingLeaseTenantIds = all(formData, 'outgoingLeaseTenantId')
  const outgoingTenantIds = lease.leaseTenants
    .filter((lt) => outgoingLeaseTenantIds.includes(lt.id))
    .map((lt) => lt.tenant.id)
  if (outgoingTenantIds.length !== outgoingLeaseTenantIds.length) {
    return { error: 'One of the people named as leaving is not on this lease.' }
  }

  const result = await buildPartyChange({
    lease,
    actorId: actor.id,
    outgoingTenantIds,
    incomingApplicantIds: all(formData, 'incomingApplicantId'),
    effectiveOn: str(formData, 'effectiveOn'),
    reason: str(formData, 'reason'),
    acknowledgedWarnings: formData.get('acknowledgeWarnings') === 'on',
    // NOT A PARAMETER THIS FUNCTION CAN SET. There is no "skip signatures"
    // option on the ordinary panel and there will not be one - see the
    // builder's own header.
    unsigned: null,
  })

  revalidatePath(`/leases/${leaseId}`)
  const { changeId: _changeId, ...state } = result
  return state
}

/**
 * Withdraws an amendment that is out for signature. REASON_REQUIRED - asking
 * several people to sign a change to their tenancy and then pulling it is an
 * act somebody will ask about later.
 *
 * The Tenant rows created for incoming parties are NOT deleted. They are
 * people, they are on no lease, and deleting a row that a LeaseSigner
 * already points at would fail anyway.
 */
export async function voidPartyChange(
  leaseId: string,
  _previous: PartyChangeFormState,
  formData: FormData,
): Promise<PartyChangeFormState> {
  const { lease } = await loadLeaseForPartyChange(leaseId)
  const changeId = str(formData, 'changeId')
  const reason = str(formData, 'reason')
  if (!reason) return { error: 'Say why this amendment is being withdrawn.' }

  const change = await prisma.leasePartyChange.findUnique({
    where: { id: changeId },
    include: { envelope: { select: { id: true, providerId: true, status: true } } },
  })
  if (!change || change.leaseId !== leaseId) return { error: 'That change no longer exists.' }
  if (change.status !== 'PENDING_SIGNATURE') {
    return { error: 'Only a change still out for signature can be withdrawn.' }
  }

  if (change.envelope?.providerId) {
    await esignAdapter
      .voidEnvelope({ providerId: change.envelope.providerId, reason })
      .catch((error: unknown) => {
        console.error(`[party-change] provider void failed for envelope ${change.envelope?.id}`, error)
      })
  }

  await prisma.$transaction(async (tx) => {
    if (change.envelope) {
      await tx.leaseEnvelope.update({
        where: { id: change.envelope.id },
        data: { status: 'VOIDED', voidedAt: new Date() },
      })
    }
    await tx.leasePartyChange.update({
      where: { id: change.id },
      data: { status: 'VOIDED', voidedAt: new Date(), voidReason: reason },
    })
    await audit(
      {
        action: 'lease.party_change_voided',
        entityType: 'Lease',
        entityId: leaseId,
        propertyId: lease.propertyId,
        reason,
        before: { changeId: change.id, status: 'PENDING_SIGNATURE' },
        after: { changeId: change.id, status: 'VOIDED' },
      },
      tx,
    )
  })

  revalidatePath(`/leases/${leaseId}`)
  return { notice: 'Amendment withdrawn.' }
}
