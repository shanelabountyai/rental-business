import 'server-only'

import { openSecret } from '@rental/core/auth'
import { SELF_SHOWING_REFUSAL_MESSAGES, namesAgree, selfShowingDecision } from '@rental/core/scheduling'
import { showingAccessLinkStatus } from './access-link.ts'

// NOT a 'use server' module, on purpose (SEC-01). It takes `now` from its
// caller; as an action export a token holder could pass any `now` inside the
// booked window and be handed the door code at any hour.

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
