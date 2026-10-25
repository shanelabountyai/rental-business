'use server'

import { applicationFeeCentsFor } from '@rental/core/applications'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { audit } from '@/lib/audit/index.ts'
import { authUrl } from '@/lib/auth/delivery.ts'
import { propertyResource, requirePermission, requireScope } from '@/lib/auth/guard.ts'
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
  const { actor: guarded } = await requireScope('lease.write')
  const prospect = await prisma.prospect.findUnique({
    where: { id: prospectId, orgId: guarded.orgId },
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

export interface NoteFormState {
  error?: string
  notice?: string
}

/**
 * An internal review note on one applicant (R-271, PRD 08 C2). Staff-only:
 * nothing in the notification engine or an applicant page reads
 * `ApplicantNote`. Append-only in practice - there is deliberately no edit or
 * delete, so what a reviewer wrote before deciding survives the decision.
 */
export async function addApplicantNote(
  _previous: NoteFormState,
  formData: FormData,
): Promise<NoteFormState> {
  const applicantId = String(formData.get('applicantId') ?? '')
  const body = String(formData.get('body') ?? '').trim()
  if (!applicantId) return { error: 'Nothing was selected.' }
  if (!body) return { error: 'Write the note first.' }
  if (body.length > 4000) return { error: 'Keep a note under 4,000 characters.' }

  const applicant = await prisma.applicant.findUniqueOrThrow({
    where: { id: applicantId },
    include: { application: { include: { property: true } } },
  })
  const { application } = applicant
  const actor = await requirePermission('screening.decide', propertyResource(application.property))

  await prisma.$transaction(async (tx) => {
    const note = await tx.applicantNote.create({
      data: { applicantId, body, authorStaffId: actor.id },
    })
    await audit(
      {
        action: 'application.note_added',
        entityType: 'ApplicantNote',
        entityId: note.id,
        propertyId: application.propertyId,
        after: { applicantId },
      },
      tx,
    )
  })

  revalidatePath(`/prospects/${application.prospectId}`)
  return { notice: 'Note saved. It is internal and never sent to the applicant.' }
}
