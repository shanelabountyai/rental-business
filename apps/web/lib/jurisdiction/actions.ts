'use server'

import { isUsStateCode } from '@rental/core/property'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { requirePermission } from '@/lib/auth/guard.ts'
import { refreshOrgHealth } from '@/lib/cron/org-health.ts'
import { rulesForConfigured } from '@/lib/jurisdiction/queries.ts'
import { platformUrl, sendPlatformEmail } from '@/lib/platform/mail.ts'

// R-298a (PRD 10 §7.2, D-389): an owner enables a state for the org and
// records its counsel's review. `jurisdiction.configure` is owner-only and
// privileged. Returns rather than redirects, like every org-host action since
// D-379. There is no "disable": a state with property in it cannot sensibly
// stop being one, and none has been asked for.

export interface OrgStateFormState {
  error?: string
  notice?: string
}

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/

export async function enableOrgState(_previous: OrgStateFormState, formData: FormData): Promise<OrgStateFormState> {
  const actor = await requirePermission('jurisdiction.configure')
  const state = String(formData.get('state') ?? '').trim().toUpperCase()
  if (!isUsStateCode(state)) return { error: 'Choose a state.' }

  // Statewide only: a county ordinance sits on top of a state rule, never
  // instead of one (`selectApplicableRule`).
  const unseeded = !(await rulesForConfigured({ state }, new Date()))
  // The platform's "Task" (D-389): an email to whoever can publish, and the
  // state listed on /platform/jurisdiction until a rule exists. Not a `Task`
  // row - that queue is an org's, worked by its staff (D-9).
  // createMany + skipDuplicates: a double press enables once, mails once.
  const { count } = await prisma.orgJurisdiction.createMany({
    data: [{ orgId: actor.orgId, state }],
    skipDuplicates: true,
  })
  if (count === 0) return { notice: `${state} is already enabled.` }
  // After the row, so the audit can say who was told.
  const sent = unseeded ? await tellPublishers(state) : []
  await audit({
    action: 'org_jurisdiction.enabled',
    entityType: 'Organization',
    entityId: actor.orgId,
    orgId: actor.orgId,
    after: { state, unseeded, ...(unseeded ? { sent } : {}) },
  })
  await refreshOrgHealth(actor.orgId)
  revalidatePath('/jurisdiction')
  return {
    notice: unseeded
      ? `${state} enabled. There is no rule for it yet, so the platform has been asked to publish one; until then nothing in ${state} can compute fees, deposits or notices.`
      : `${state} enabled. Record your counsel’s review of it below.`,
  }
}

export async function recordCounselReview(_previous: OrgStateFormState, formData: FormData): Promise<OrgStateFormState> {
  const actor = await requirePermission('jurisdiction.configure')
  const state = String(formData.get('state') ?? '')
  const reviewedBy = String(formData.get('reviewedBy') ?? '').trim()
  const reviewedOn = String(formData.get('reviewedOn') ?? '')
  if (!reviewedBy) return { error: 'Name the counsel who reviewed it.' }
  if (reviewedBy.length > 200) return { error: 'Keep the counsel’s name under 200 characters.' }
  // A date input sends nothing else, but a hand-made POST can.
  const day = BUSINESS_DATE.test(reviewedOn) ? new Date(`${reviewedOn}T00:00:00Z`) : null
  if (!day || Number.isNaN(day.getTime())) return { error: 'Enter the date of the review.' }
  // UTC midnight of any US calendar day is never ahead of now, so this
  // refuses only a day that has not started anywhere in the country.
  if (day > new Date()) return { error: 'The review date cannot be in the future.' }

  const row = await prisma.orgJurisdiction.findUnique({ where: { orgId_state: { orgId: actor.orgId, state } } })
  if (!row) return { error: `${state} is not enabled for your organisation.` }

  await prisma.$transaction(async (tx) => {
    await tx.orgJurisdiction.update({
      where: { id: row.id },
      data: { counselReviewedBy: reviewedBy, counselReviewedAt: day },
    })
    await audit(
      {
        action: 'org_jurisdiction.counsel_reviewed',
        entityType: 'Organization',
        entityId: actor.orgId,
        orgId: actor.orgId,
        before: { counselReviewedBy: row.counselReviewedBy, counselReviewedAt: row.counselReviewedAt },
        after: { state, counselReviewedBy: reviewedBy, counselReviewedAt: reviewedOn },
      },
      tx,
    )
  })
  await refreshOrgHealth(actor.orgId)
  revalidatePath('/jurisdiction')
  return { notice: `Recorded: ${reviewedBy} reviewed the ${state} rules.` }
}

/// Every active admin who can publish a rule. Which org asked stays out of
/// the mail: the console lists the state, and the org's own audit row
/// records who was told.
async function tellPublishers(state: string) {
  const publishers = await prisma.platformAdmin.findMany({
    where: {
      active: true,
      roles: { some: { revokedAt: null, role: { permissions: { has: 'jurisdiction.publish' } } } },
    },
    select: { id: true, email: true },
  })
  let link: string
  try {
    link = platformUrl(`/platform/jurisdiction/new?state=${state}`)
  } catch {
    link = '/platform/jurisdiction'
  }
  const body = [
    `An organisation has enabled ${state}, and no statewide rule is published for it.`,
    '',
    `Until one is, its properties in ${state} cannot compute fees, deposits or notices. Publish one here:`,
    link,
  ].join('\n')
  const sent: { recipientId: string; status: string }[] = []
  for (const admin of publishers) {
    const outcome = await sendPlatformEmail(admin.email, `No jurisdiction rule for ${state}`, body)
    sent.push({ recipientId: admin.id, status: outcome.status })
  }
  return sent
}
