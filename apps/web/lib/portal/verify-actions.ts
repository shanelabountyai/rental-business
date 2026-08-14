'use server'

import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { requireTenantWithScope } from '@/lib/portal/guard.ts'
import { recordVerification } from './verify-record.ts'

// The tenant's one tap, from inside the portal (MAINT-07, R-030).
//
// Lives on the PORTAL side, with the portal's own guard, because the actor
// is a tenant and `requirePermission()` reads a staff session. R-018's rule,
// restated: the tenant side never falls through to the staff side.
//
// THIS FILE IS NOW ONLY THE AUTHENTICATED DOORWAY (R-032c). Everything after
// "we know which tenant is answering which job" moved to `verify-record.ts`,
// because there are two doorways now — this one and the magic link — and a
// second copy of the status transition, the round arithmetic, the reopen
// clearing and the task fan-out is how the two answers start meaning
// different things.

export interface VerifyFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

export async function verifyWorkOrder(
  _previous: VerifyFormState,
  formData: FormData,
): Promise<VerifyFormState> {
  const { scope } = await requireTenantWithScope()

  const workOrderId = String(formData.get('workOrderId') ?? '')
  const answer = String(formData.get('resolved') ?? '')
  const ratingRaw = String(formData.get('rating') ?? '')

  const outcome = await recordVerification(workOrderId, scope.tenantId, {
    resolved: answer === 'yes' ? true : answer === 'no' ? false : undefined,
    rating: ratingRaw ? Number(ratingRaw) : null,
    comment: String(formData.get('comment') ?? '').trim() || null,
  },
    // The SESSION's actor, which also carries IP and user-agent — worth more
    // than the token path can offer, and the reason attribution is passed in
    // rather than fixed inside the recorder.
    audit,
  )

  // Validation lives with the write, not here. Duplicating it would let the
  // portal and the link disagree about what counts as an answer.
  if (!outcome.ok) return { error: outcome.error, fieldErrors: outcome.fieldErrors }

  if (outcome.ticketId) revalidatePath(`/portal/maintenance/${outcome.ticketId}`)
  revalidatePath('/portal/maintenance')
  return { notice: outcome.notice }
}
