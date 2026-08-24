'use server'

import { openSecret } from '@rental/core/auth'
import { holdTypeLabel, holdsCausing } from '@rental/core/holds'
import { prisma } from '@rental/db'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { activeHoldsForLease } from '@/lib/holds/queries.ts'
import {
  ISSUE_REFUSAL_MESSAGES,
  issueTenantLockCodeFor,
  revokeTenantLockCodes,
} from '@/lib/locks/tenant-codes.ts'
import { revalidatePath } from 'next/cache'

// Handing keys/codes to the tenant at move-in, gated on move-in funds
// clearing (INSP-01, R-069) - "door codes withheld until move-in funds show
// cleared". A plain `accesscode.reveal` (a vendor or tech viewing a code for
// a job) is a different act from releasing a code to the tenant who will
// hold it going forward, so this is its own permission and its own audit
// action, not a reuse of either.
//
// A HARD BLOCK, not a warn+override. The notice-period and retaliation
// warnings elsewhere in this codebase (R-055, R-066) exist because those are
// business judgment calls a staffer might have good reason to make anyway.
// Whether the money is actually safe to act on is not a judgment call - it
// is the entire point of the rule, so there is no reason field to override
// it with.

const ACCESS_CODE_PURPOSE = 'access-code'

export interface IssueCodeState {
  error?: string
  code?: string
  label?: string
}

export async function issueAccessCodeToTenant(
  leaseId: string,
  accessCodeId: string,
): Promise<IssueCodeState> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    select: {
      id: true,
      unitId: true,
      propertyId: true,
      depositCents: true,
      property: { select: { id: true, legalEntityId: true } },
      deposits: { select: { id: true }, take: 1 },
    },
  })
  await requirePermission('accesscode.issue', propertyResource(lease.property))

  // R-084. A hold that halts access changes is on a tenancy where who is
  // lawfully entitled to possession is exactly what is unsettled — a dead
  // tenant whose estate has not named anyone, a servicemember, a stay. A
  // hard block for the same reason the funds check below is one: this is not
  // a judgement call somebody might have good reason to make anyway, it is
  // the whole content of the hold. Lifting the hold is the override, and it
  // is recorded.
  const holds = await activeHoldsForLease(lease.id)
  const halting = holdsCausing(holds, 'halt_access_changes')
  if (halting.length > 0) {
    return {
      error: `Access changes are halted on this tenancy: ${halting
        .map(holdTypeLabel)
        .join(', ')}. Lift the hold on the lease record first.`,
    }
  }

  if (lease.depositCents > 0 && lease.deposits.length === 0) {
    return {
      error:
        'Move-in funds have not cleared yet. Certified funds (money order, cash, ACH, card) clear immediately once settled; a personal check clears after its hold period.',
    }
  }

  const accessCode = await prisma.accessCode.findUniqueOrThrow({ where: { id: accessCodeId } })
  if (accessCode.unitId !== lease.unitId) {
    return { error: 'This code does not belong to this unit.' }
  }

  const code = openSecret(accessCode.sealedCode, ACCESS_CODE_PURPOSE)
  if (code == null) {
    return { error: 'This code could not be decrypted. It may predate a secret rotation.' }
  }

  await audit({
    action: 'accesscode.issued',
    entityType: 'Lease',
    entityId: leaseId,
    propertyId: lease.propertyId,
    after: {
      accessCodeId: accessCode.id,
      unitId: accessCode.unitId,
      type: accessCode.type,
      label: accessCode.label,
      version: accessCode.version,
    },
  })

  // NO revalidatePath. `revealAccessCode`'s own action takes the identical
  // posture for the identical reason (CLAUDE.md's "Server Action refresh
  // trap"): revalidating here would re-render the lease page's Server tree
  // as part of THIS action's own response, and the freshly-audited
  // `issuedAt` would immediately swap the button for an "Issued" label -
  // unmounting the very component whose local `useActionState` result was
  // about to show the code. The code only ever lives in the client's local
  // state, same as a reveal; the persisted "Issued" label appears on the
  // next real navigation, when the server renders from current data anyway.
  return { code, label: accessCode.label ?? accessCode.type }
}

// ---------------------------------------------------------------------------
// R-094b: the tenant's own smart-lock code
// ---------------------------------------------------------------------------

export interface TenantLockCodeState {
  error?: string
  notice?: string
  code?: string
  fieldErrors?: Record<string, string>
}

/**
 * Issues one tenant their own code at the door.
 *
 * THE SAME TWO GATES AS `issueAccessCodeToTenant` ABOVE, and they are shared
 * rather than restated: whether the money is safe to act on and whether a
 * hold has halted access changes do not become different questions because
 * the lock is electronic. Both are hard blocks with no override, for the
 * reason that file's own header gives.
 *
 * WHAT IS DIFFERENT is that this one actually programs a door. The static
 * path above records a handover of a code that already existed; this mints
 * one at the device, and the code that comes back is the code the lock will
 * accept.
 */
export async function issueTenantLockCode(
  leaseId: string,
  tenantId: string,
): Promise<TenantLockCodeState> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    select: {
      id: true,
      propertyId: true,
      depositCents: true,
      property: { select: { id: true, legalEntityId: true } },
      deposits: { select: { id: true }, take: 1 },
    },
  })
  const actor = await requirePermission('accesscode.issue', propertyResource(lease.property))

  const holds = await activeHoldsForLease(lease.id)
  const halting = holdsCausing(holds, 'halt_access_changes')
  if (halting.length > 0) {
    return {
      error: `Access changes are halted on this tenancy: ${halting
        .map(holdTypeLabel)
        .join(', ')}. Lift the hold on the lease record first.`,
    }
  }
  if (lease.depositCents > 0 && lease.deposits.length === 0) {
    return {
      error:
        'Move-in funds have not cleared yet. Certified funds (money order, cash, ACH, card) clear immediately once settled; a personal check clears after its hold period.',
    }
  }

  const result = await issueTenantLockCodeFor({ leaseId, tenantId, staffId: actor.id })
  if (result.refusal) return { error: ISSUE_REFUSAL_MESSAGES[result.refusal] }

  await audit({
    action: 'accesscode.issued',
    entityType: 'Lease',
    entityId: leaseId,
    propertyId: lease.propertyId,
    after: {
      tenantLockCodeId: result.issued.id,
      tenantId,
      // Says the DOOR was programmed, which is the fact that distinguishes
      // this from the static handover above. Never the code itself.
      programmedAtDevice: true,
    },
  })

  // NO revalidatePath, the same call the static path above makes and for the
  // identical reason: revalidating would re-render this lease page's Server
  // tree as part of this action's own response and unmount the component
  // whose local state was about to show the code.
  return { code: result.issued.code }
}

/**
 * Revokes one tenant's door code.
 *
 * `lease.write` AND DELIBERATELY NOT PRIVILEGED, unlike issuing. R-084's
 * rule, and R-094 already applied it to a viewer's code: gating the safe
 * direction behind MFA is how the safe direction stops being taken, and
 * somebody who has just learned that a former occupant can still walk in
 * must be able to stop it from whatever device is in their hand.
 */
export async function revokeTenantLockCode(
  leaseId: string,
  tenantId: string,
  _previous: TenantLockCodeState,
  formData: FormData,
): Promise<TenantLockCodeState> {
  const lease = await prisma.lease.findUniqueOrThrow({
    where: { id: leaseId },
    select: { id: true, propertyId: true, property: { select: { id: true, legalEntityId: true } } },
  })
  const actor = await requirePermission('lease.write', propertyResource(lease.property))

  const reason = String(formData.get('reason') ?? '').trim()
  if (!reason) {
    return {
      error: 'Fix the highlighted field.',
      fieldErrors: { reason: 'Say why this door code is being revoked.' },
    }
  }

  const revoked = await revokeTenantLockCodes({ leaseId, tenantId }, { reason, staffId: actor.id })
  if (revoked.length === 0) return { error: 'They hold no live door code on this tenancy.' }

  await audit({
    action: 'accesscode.tenant_code_revoked',
    entityType: 'Lease',
    entityId: leaseId,
    propertyId: lease.propertyId,
    reason,
    after: {
      tenantId,
      codeIds: revoked.map((code) => code.id),
      reachedDevice: revoked.every((code) => code.reachedDevice),
    },
  })

  revalidatePath(`/leases/${leaseId}`)
  return {
    notice: revoked.every((code) => code.reachedDevice)
      ? 'Revoked. It no longer opens the door.'
      : 'Recorded, but the lock did not answer — treat that code as still working until somebody has confirmed it at the device.',
  }
}
