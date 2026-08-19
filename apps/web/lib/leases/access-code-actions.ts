'use server'

import { openSecret } from '@rental/core/auth'
import { prisma } from '@rental/db'
import { audit } from '@/lib/audit/index.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'

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
