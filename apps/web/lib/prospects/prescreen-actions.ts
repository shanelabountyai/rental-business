'use server'

import { type PrescreenAnswersInput, validatePrescreenAnswers } from '@rental/core/prospects'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { auditAsSystem } from '@/lib/audit/system.ts'
import { redeemToken } from '@/lib/auth/store.ts'
import { prescreenLinkStatus } from './prescreen-link.ts'

// Recording a prospect's answers (LEASE-07, R-058).
//
// THE ANSWER IS A POST, NEVER A GET - same reasoning R-032c's own
// verify-link-actions.ts states: an SMS client's or a carrier's
// link-safety scanner follows GET URLs on its own, and a scanner that
// silently "answered" five fair-housing-sensitive questions on a
// prospect's behalf is a worse failure than a form that requires a tap.
//
// The token is checked AGAIN here, not trusted from the page that
// rendered the form - it can go stale (expire, get answered from another
// tab) in the gap between render and submit, the same gap
// verify-link-actions.ts's own comment names.

export interface PrescreenFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

function parseDateOnly(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim())
  if (!match) return null
  const [, y, m, d] = match
  const date = new Date(Date.UTC(+y!, +m! - 1, +d!))
  return Number.isNaN(date.getTime()) ? null : date
}

function violationsToState(
  violations: readonly { field: string; message: string }[],
): PrescreenFormState {
  return {
    error: 'Fix the highlighted fields.',
    fieldErrors: Object.fromEntries(violations.map((v) => [v.field, v.message])),
  }
}

const LINK_ERROR_MESSAGES: Record<string, string> = {
  not_found: 'This link is not valid.',
  wrong_purpose: 'This link is not valid.',
  wrong_subject: 'This link is not valid.',
  already_used: 'This link has already been used.',
  expired: 'This link has expired.',
  already_answered: 'These questions have already been answered.',
}

export async function submitPrescreenAnswers(
  rawToken: string,
  _previous: PrescreenFormState,
  formData: FormData,
): Promise<PrescreenFormState> {
  const status = await prescreenLinkStatus(rawToken)
  if (!status.ok) {
    return { error: LINK_ERROR_MESSAGES[status.reason] ?? 'This link is not valid.' }
  }

  const priorEvictionsRaw = str(formData, 'priorEvictions')
  const input: PrescreenAnswersInput = {
    moveDate: parseDateOnly(str(formData, 'moveDate')),
    occupants: str(formData, 'occupants') ? Number(str(formData, 'occupants')) : null,
    petsDescription: str(formData, 'petsDescription') || null,
    incomeRange: str(formData, 'incomeRange') || null,
    priorEvictions:
      priorEvictionsRaw === 'yes' ? true : priorEvictionsRaw === 'no' ? false : null,
    priorEvictionsDetail: str(formData, 'priorEvictionsDetail') || null,
  }
  const violations = validatePrescreenAnswers(input)
  if (violations.length > 0) return violationsToState(violations)

  // Redeemed only now, after validation - a form rejected for a bad answer
  // must not burn the one link the prospect has.
  const redeemed = await redeemToken(rawToken, {
    purpose: 'PROSPECT_PRESCREEN',
    subjectType: 'Prospect',
  })
  if (!redeemed.ok) {
    return { error: 'This link has already been used or has expired.' }
  }

  await prisma.$transaction(async (tx) => {
    await tx.prospect.update({
      where: { id: status.prospect.id },
      data: {
        moveDate: input.moveDate!,
        occupants: input.occupants,
        petsDescription: input.petsDescription,
        incomeRange: input.incomeRange,
        priorEvictions: input.priorEvictions,
        priorEvictionsDetail: input.priorEvictionsDetail,
        preScreenRespondedAt: new Date(),
        status: 'PRE_SCREENED',
      },
    })
    // SYSTEM, named to the prospect who answered - there is no staff or
    // tenant session here, the same reasoning auditAsSystem's own header
    // gives for a job or a webhook, applied to a public form instead.
    await auditAsSystem(
      `prospect:${status.prospect.id}`,
      {
        action: 'prospect.prescreened',
        entityType: 'Prospect',
        entityId: status.prospect.id,
        propertyId: status.prospect.propertyId,
        after: { incomeRange: input.incomeRange, priorEvictions: input.priorEvictions },
      },
      tx,
    )
  })

  // Without this, the page (a Server Component reading prescreenLinkStatus()
  // on every request) has no reason to refetch, and the client-side
  // useActionState update alone never reaches it - the "already answered"
  // branch that IS this page's success screen (see the page's own comment)
  // would never actually render.
  revalidatePath(`/prescreen/${rawToken}`)

  return { notice: "Thanks - we'll be in touch." }
}
