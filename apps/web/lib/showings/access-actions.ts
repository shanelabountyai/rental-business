'use server'

import { openSecret, sealSecret } from '@rental/core/auth'
import {
  SELF_SHOWING_REFUSAL_MESSAGES,
  accessWindow,
  canIssueSelfShowingCode,
  namesAgree,
  selfShowingDecision,
} from '@rental/core/scheduling'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { identityAdapter, smartLockAdapter } from '@/lib/locks/provider.ts'
import { showingAccessLinkStatus } from './access-link.ts'

// PUBLIC writes for a self-showing (LEASE-08, R-094) - no session, the same
// posture showings/actions.ts takes, and it must stay import-clean of
// lib/audit/index.ts for the same reason (see that file's header).
//
// ==========================================================================
// THE ONE THING THIS FILE MUST NEVER DO is hand a code to somebody the
// decision function did not clear. Every path to a code goes through
// `selfShowingDecision`, and the row it writes cannot exist without the
// identity check that bought it - `ShowingAccess.identityCheckId` is NOT
// NULL at the database, so there is no future code path that can skip it
// either.
//
// THE CHECK IS RE-RUN AT EVERY READ, not once at issue. Between minting a
// code and somebody standing at the door, the unit can be let, the showing
// can be cancelled and a person can pull the code. The row says a code
// exists; the decision says whether it may be handed over now.
// ==========================================================================

export interface AccessFormState {
  error?: string
  notice?: string
  fieldErrors?: Record<string, string>
}

const LINK_ERROR_MESSAGES: Record<string, string> = {
  not_found: 'This link is not valid.',
  wrong_purpose: 'This link is not valid.',
  wrong_subject: 'This link is not valid.',
  expired:
    'This link has expired. Call the office and they will send you a new one — it takes a moment.',
}

/**
 * The prospect confirms who they are, and a code is minted if they clear.
 *
 * ONE ACTION FOR BOTH, deliberately. A verify step that stopped short of
 * issuing would leave a verified prospect on a page with a button somebody
 * has to remember to press, and the two have exactly the same preconditions.
 *
 * IT IS SAFE TO RUN AGAIN. A prospect who already holds a code gets told so
 * rather than getting a second one: `ShowingAccess.showingId` is unique, and
 * two live codes for one viewing is two things to kill when one of them has
 * to go.
 */
export async function verifyIdentityForShowing(
  rawToken: string,
  _previous: AccessFormState,
  formData: FormData,
): Promise<AccessFormState> {
  const link = await showingAccessLinkStatus(rawToken)
  if (!link.ok) return { error: LINK_ERROR_MESSAGES[link.reason] ?? 'This link is not valid.' }
  if (link.access) {
    return {
      notice: 'You are already confirmed. Your code appears on this page at the time you booked.',
    }
  }

  const documentName = String(formData.get('documentName') ?? '').trim()
  if (!documentName) {
    return {
      error: 'Fix the highlighted field.',
      fieldErrors: {
        documentName: 'Type your name exactly as it is printed on your photo ID.',
      },
    }
  }

  // The gate BEFORE the provider is called, so an occupied unit or a
  // cancelled showing never reaches a third party at all. Same function the
  // reveal uses, so the two cannot drift.
  const gate = canIssueSelfShowingCode({
    unitStatus: link.unitStatus,
    hasActiveSmartLock: link.smartLock?.active === true,
    showingStatus: link.showingStatus,
    scheduledStart: link.scheduledStart,
    scheduledEnd: link.scheduledEnd,
    identity: { result: 'VERIFIED', namesAgree: true },
  })
  if (gate.refusal) return { error: SELF_SHOWING_REFUSAL_MESSAGES[gate.refusal] }

  let outcome: Awaited<ReturnType<typeof identityAdapter.verify>>
  try {
    outcome = await identityAdapter.verify({ prospectId: link.prospectId, documentName })
  } catch (error) {
    console.error(`[self-showing] identity provider failed for prospect ${link.prospectId}`, error)
    return {
      error:
        'We could not check your ID just now. Try again in a minute, and call the office if it keeps failing — do not go to the property without a code.',
    }
  }

  // THE COMPARISON IS OURS, NOT THE PROVIDER'S (D-27, and the reason this
  // feature verifies anybody at all). A provider can say a document is
  // genuine and readable; only this system knows who booked the slot, so a
  // real licence belonging to somebody else comes back VERIFIED from them
  // and has to be caught here.
  const agrees = namesAgree(link.prospectName, outcome.documentName)
  const result =
    outcome.result === 'FAILED' ? 'FAILED' : agrees ? 'VERIFIED' : 'NAME_MISMATCH'

  const check = await prisma.identityCheck.create({
    data: {
      prospectId: link.prospectId,
      provider: identityAdapter.name,
      reference: outcome.reference,
      result,
      documentName: outcome.documentName,
    },
  })
  await auditAsSystem(`self-showing:${link.prospectId}`, {
    action: 'showing.identity_checked',
    entityType: 'Showing',
    entityId: link.showingId,
    propertyId: link.propertyId,
    after: {
      identityCheckId: check.id,
      result,
      provider: identityAdapter.name,
      reference: outcome.reference,
      // Whether the names agreed, never the name itself: this payload is
      // what `audit.read` exposes broadly, and the row behind it already
      // holds the name for whoever needs to reconstruct the decision.
      namesAgree: agrees,
    },
  })

  if (result !== 'VERIFIED') {
    revalidatePath(`/showings/access/${rawToken}`)
    return {
      error:
        result === 'NAME_MISMATCH'
          ? SELF_SHOWING_REFUSAL_MESSAGES.identity_mismatch
          : 'We could not read that. Check the spelling against your ID and try again.',
    }
  }

  const window = accessWindow(link)
  let issued: Awaited<ReturnType<typeof smartLockAdapter.issueCode>>
  try {
    issued = await smartLockAdapter.issueCode({
      externalId: link.smartLock!.externalId,
      validFrom: window.validFrom,
      validTo: window.validTo,
      // A LABEL, NOT A NAME. It goes into a device's own log, which is a
      // third party's system with its own retention and its own readers -
      // and the showing id is enough for us to match it back.
      label: `Viewing ${link.showingId.slice(-6)}`,
    })
  } catch (error) {
    console.error(`[self-showing] lock refused a code for showing ${link.showingId}`, error)
    // The check STANDS. It really happened, and making the prospect prove
    // who they are twice because a device was offline is the wrong failure.
    return {
      error:
        'You are confirmed, but the lock did not answer. Try this page again shortly, and call the office if the code is still missing when you arrive.',
    }
  }

  await prisma.$transaction(async (tx) => {
    const access = await tx.showingAccess.create({
      data: {
        showingId: link.showingId,
        smartLockId: link.smartLock!.id,
        identityCheckId: check.id,
        providerRef: issued.providerRef,
        sealedCode: sealSecret(issued.code, 'access-code'),
        validFrom: window.validFrom,
        validTo: window.validTo,
      },
    })
    await auditAsSystem(
      `self-showing:${link.prospectId}`,
      {
        action: 'showing.access_issued',
        entityType: 'Showing',
        entityId: link.showingId,
        propertyId: link.propertyId,
        after: {
          accessId: access.id,
          identityCheckId: check.id,
          providerRef: issued.providerRef,
          validFrom: window.validFrom.toISOString(),
          validTo: window.validTo.toISOString(),
          // Never the code. This is the table `audit.read` exposes broadly,
          // and a trail carrying the thing it is recording the release of
          // has moved the secret rather than logged it.
        },
      },
      tx,
    )
  })

  revalidatePath(`/showings/access/${rawToken}`)
  return {
    notice:
      'Confirmed. Your entry code appears on this page from a few minutes before the time you booked.',
  }
}

export interface RevealedCode {
  code: string | null
  refusalMessage: string | null
  validFrom: Date
  validTo: Date
}

/**
 * What to show on the page right now.
 *
 * A READ, not an action, and it is called from the page on every render -
 * which is the whole design. The code is never in a message, never in the
 * URL and never cached: it exists on a page that re-decides whether it may
 * be shown each time somebody looks at it, so killing it takes effect on the
 * prospect's next refresh rather than whenever an SMS is deleted.
 */
export async function revealShowingCode(rawToken: string, now: Date): Promise<RevealedCode | null> {
  const link = await showingAccessLinkStatus(rawToken)
  if (!link.ok || !link.access) return null

  const decision = selfShowingDecision({
    now,
    unitStatus: link.unitStatus,
    hasActiveSmartLock: link.smartLock?.active === true,
    showingStatus: link.showingStatus,
    scheduledStart: link.scheduledStart,
    scheduledEnd: link.scheduledEnd,
    identity: link.identity
      ? {
          result: link.identity.result as 'VERIFIED' | 'NAME_MISMATCH' | 'FAILED',
          namesAgree: namesAgree(link.prospectName, link.identity.documentName),
        }
      : null,
    revokedAt: link.access.revokedAt,
  })

  if (decision.refusal) {
    return {
      code: null,
      refusalMessage: SELF_SHOWING_REFUSAL_MESSAGES[decision.refusal],
      validFrom: link.access.validFrom,
      validTo: link.access.validTo,
    }
  }
  return {
    code: openSecret(link.access.sealedCode, 'access-code'),
    refusalMessage: null,
    validFrom: link.access.validFrom,
    validTo: link.access.validTo,
  }
}
