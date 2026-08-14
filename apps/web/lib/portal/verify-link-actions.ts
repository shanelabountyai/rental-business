'use server'

import { revalidatePath } from 'next/cache'
import { auditAsTenant } from '@/lib/audit/system.ts'
import { recordVerification } from './verify-record.ts'
// `rejectionMessage` lives in verify-link.ts, NOT here: a `'use server'`
// module may export only async functions, so a plain string helper exported
// from this file would have to return a Promise — and the first version did,
// which put a pending Promise in the error field instead of a sentence.
import { rejectionMessage, verifyVerifyLink } from './verify-link.ts'

// Answering from the magic link (MAINT-07, R-032c).
//
// ==========================================================================
// THE ANSWER IS A POST, NEVER A GET, AND THIS IS THE SECURITY DECISION.
//
// The obvious design — and the one the backlog row asks for — is a token
// "carrying the answer", so the message holds two links and the tenant taps
// the one they mean. That is genuinely one tap, and it is unsafe here: SMS
// clients, carrier link-safety scanners and email security gateways all
// FOLLOW URLS to check them. A GET that records "yes, it is fixed" would be
// answered by a scanner before the tenant ever read the message, and the job
// would close itself.
//
// So the token identifies the QUESTION and the page presents the two
// answers as form submissions. The cost is one extra tap; the alternative is
// a work order that closes because a security appliance was doing its job.
// ==========================================================================
//
// NO SESSION IS CREATED. The token authorizes exactly one write, and is
// re-verified here rather than trusted from the page that rendered the form
// — a page can be stale, and the hidden field is attacker-controlled.

export interface VerifyLinkFormState {
  error?: string
  notice?: string
  answered?: boolean
}

export async function answerFromLink(
  token: string,
  _previous: VerifyLinkFormState,
  formData: FormData,
): Promise<VerifyLinkFormState> {
  // RE-VERIFIED on the write, not carried over from the GET. Between the
  // page rendering and the tenant tapping, the job may have been reopened,
  // answered in the portal, or the link revoked by a resend.
  const link = await verifyVerifyLink(token)
  if (!link.ok) {
    return { error: rejectionMessage(link.reason), answered: link.reason === 'answered' }
  }

  const answer = String(formData.get('resolved') ?? '')
  if (answer !== 'yes' && answer !== 'no') {
    return { error: 'Please choose yes or no.' }
  }

  const comment = String(formData.get('comment') ?? '').trim() || null
  const ratingRaw = String(formData.get('rating') ?? '')

  const outcome = await recordVerification(
    link.workOrderId,
    link.tenantId,
    {
      resolved: answer === 'yes',
      // Optional and deliberately secondary (R-030): a required rating puts a
      // second decision between a tenant and "yes, it is fixed", which is the
      // tap that actually matters.
      rating: ratingRaw ? Number(ratingRaw) : null,
      comment,
    },
    // ATTRIBUTED TO THE TENANT THE TOKEN NAMES. `audit()` would find no
    // session here and record SYSTEM / anonymous — so "who said this repair
    // was fixed" would answer *nobody*, on the one record whose entire value
    // is that a named tenant said it.
    (entry, tx) => auditAsTenant(link.tenantId, entry, tx),
  )

  if (!outcome.ok) return { error: outcome.error }

  // The portal still exists for tenants who use it, and its cached pages now
  // hold a stale answer.
  if (outcome.ticketId) revalidatePath(`/portal/maintenance/${outcome.ticketId}`)
  revalidatePath('/portal/maintenance')

  return { notice: outcome.notice, answered: true }
}

