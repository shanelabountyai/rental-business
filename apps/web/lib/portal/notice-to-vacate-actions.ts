'use server'

import { canGiveNotice, parseLeaseDate } from '@rental/core/leases'
import { noticePeriodCheckFor } from '@/lib/leases/notice-period-check.ts'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { requireTenantWithScope } from './guard.ts'
import { getTenantHome } from './queries.ts'

// The tenant's own "give notice to vacate" (LEASE-11, R-066).
//
// Lives on the PORTAL side, with the portal's own guard, same reasoning
// verify-actions.ts's own header gives: the actor is a tenant, and
// `requirePermission()` reads a staff session.
//
// NO OVERRIDE ROUND TRIP for a short notice period here, unlike the STAFF
// side (recordLeaseNotice) - a tenant is not defending a BUSINESS decision
// to proceed anyway that a later dispute could turn on, they are stating
// when they are leaving. A short notice is simply told to them as a fact
// with a consequence (they may owe rent through the required period), not
// something they must justify to their own landlord's software.

export interface NoticeToVacateFormState {
  error?: string
  fieldErrors?: Record<string, string>
  notice?: string
}

export async function submitNoticeToVacate(
  _previous: NoticeToVacateFormState,
  formData: FormData,
): Promise<NoticeToVacateFormState> {
  const { scope } = await requireTenantWithScope()
  const home = await getTenantHome(scope)
  if (!home) {
    return { error: 'We do not have a home on file for you yet. Send us a message instead.' }
  }

  const decision = canGiveNotice({ status: home.status, noticeGivenAt: home.noticeGivenAt })
  if (!decision.allowed) return { error: decision.message }

  // The confirmation gate (R-111), the same `agree` field and the same
  // server-side check the lease and inspection signatures use - checked
  // BEFORE the date is even parsed, so an unchecked box is never reported as
  // a date problem.
  if (formData.get('agree') !== 'on') {
    return {
      error: 'Tick the box to confirm you want to end your tenancy.',
      fieldErrors: { agree: 'Required.' },
    }
  }

  const effectiveOnRaw = String(formData.get('effectiveOn') ?? '').trim()
  const effectiveOn = parseLeaseDate(effectiveOnRaw)
  if (!effectiveOn) {
    return {
      error: 'Say when you plan to move out.',
      fieldErrors: { effectiveOn: 'Check the date.' },
    }
  }
  const forwardingAddress = String(formData.get('forwardingAddress') ?? '').trim() || null

  const now = new Date()
  const period = await noticePeriodCheckFor({
    propertyState: home.property.state,
    propertyCounty: home.property.county,
    givenOn: now,
    effectiveOn,
  })

  await prisma.$transaction(async (tx) => {
    await tx.lease.update({
      where: { id: home.id },
      data: {
        noticeGivenAt: now,
        noticeGivenBy: 'TENANT',
        noticeEffectiveOn: effectiveOn,
        noticeForwardingAddress: forwardingAddress,
      },
    })
    await audit(
      {
        action: 'lease.notice_given',
        entityType: 'Lease',
        entityId: home.id,
        propertyId: home.propertyId,
        after: {
          noticeGivenAt: now.toISOString(),
          noticeGivenBy: 'TENANT',
          effectiveOn: effectiveOn.toISOString(),
        },
      },
      tx,
    )
  })

  revalidatePath('/portal/papers/notice')
  revalidatePath('/portal')

  return {
    notice: period.needsOverride
      ? `Notice recorded for ${effectiveOnRaw}. This is short of the ${period.requiredDays}-day notice this lease requires, so you may still owe rent through the required period - contact us with any questions.`
      : `Notice recorded. We'll be in touch about move-out before ${effectiveOnRaw}.`,
  }
}
