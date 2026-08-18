'use server'

import { applicationFeeCentsFor } from '@rental/core/applications'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { authUrl } from '@/lib/auth/delivery.ts'
import { propertyResource, requirePermission } from '@/lib/auth/guard.ts'
import { issueToken } from '@/lib/auth/store.ts'
import { rulesFor } from '@/lib/jurisdiction/queries.ts'
import { notify } from '@/lib/notifications/send.ts'

// STAFF writes for Application/Applicant (LEASE-03, R-059) - separate from
// actions.ts, which has to stay import-clean of lib/audit/index.ts (and
// therefore of Auth.js) so it can be tested with no session at all. Same
// split prospects/staff-actions.ts already draws for the identical reason.

export interface InviteFormState {
  error?: string
}

/**
 * Staff invites a prospect to apply - creates the Application group and its
 * lead Applicant (prefilled from the Prospect's own contact info) in one
 * step, mints that applicant their own APPLICATION_LINK, and sends it.
 *
 * A prospect gets AT MOST ONE live Application from this action - a second
 * invite is refused rather than creating a parallel group, so "the
 * application" stays unambiguous everywhere it is read from a prospect.
 */
export async function inviteToApply(
  prospectId: string,
  _previous: InviteFormState,
  _formData: FormData,
): Promise<InviteFormState> {
  const prospect = await prisma.prospect.findUnique({
    where: { id: prospectId },
    include: { property: true, listing: true },
  })
  if (!prospect) return { error: 'That prospect no longer exists.' }
  await requirePermission('lease.write', propertyResource(prospect.property))

  const existing = await prisma.application.findFirst({ where: { prospectId } })
  if (existing) return { error: 'This prospect already has an application.' }

  const rule = await rulesFor(prospect.property, new Date())
  const feeCents = applicationFeeCentsFor(
    prospect.listing.applicationFeeCents,
    rule.applicationFeeCapCents,
  )

  const applicant = await prisma.$transaction(async (tx) => {
    const application = await tx.application.create({
      data: {
        propertyId: prospect.propertyId,
        listingId: prospect.listingId,
        prospectId,
      },
    })
    const created = await tx.applicant.create({
      data: {
        applicationId: application.id,
        isLead: true,
        firstName: prospect.firstName,
        lastName: prospect.lastName,
        email: prospect.email,
        phone: prospect.phone,
        feeCents: feeCents > 0 ? feeCents : null,
      },
    })
    await audit(
      {
        action: 'application.invited',
        entityType: 'Application',
        entityId: application.id,
        propertyId: prospect.propertyId,
        after: { prospectId, applicantId: created.id, feeCents },
      },
      tx,
    )
    return created
  })

  const issued = await issueToken('APPLICATION_LINK', { type: 'Applicant', id: applicant.id })
  await notify({
    category: 'prospect_application',
    templateKey: 'application.invite',
    recipient: {
      type: 'APPLICANT',
      id: applicant.id,
      email: applicant.email,
      phone: applicant.phone,
    },
    context: {
      firstName: applicant.firstName,
      addressLine1: prospect.property.addressLine1,
      url: authUrl(`/apply/${issued.token}`),
    },
    propertyId: prospect.propertyId,
    idempotencyKey: `applicant-invite:${applicant.id}`,
  })

  revalidatePath(`/prospects/${prospectId}`)
  return {}
}
