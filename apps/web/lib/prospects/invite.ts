import 'server-only'

import { prisma } from '@rental/db'
import { authUrl } from '@/lib/auth/delivery.ts'
import { issueToken } from '@/lib/auth/store.ts'
import { notify } from '@/lib/notifications/send.ts'

// NOT a 'use server' module, on purpose (SEC-01). Every export of one is a
// public endpoint, and this takes a bare prospect id with no session and no
// token - reachable as an action, it would send any prospect a fresh invite.

/**
 * Mints a single-use PROSPECT_PRESCREEN token and sends the identical
 * invite. The Prospect row survives even when this fails (a bad address, a
 * provider outage) - see the caller's own comment for why this runs
 * outside the write's transaction. Exported rather than kept private so a
 * later resend control has something to call; none exists yet (left
 * behind, below).
 */
export async function sendPrescreenInvite(prospectId: string): Promise<void> {
  const prospect = await prisma.prospect.findUniqueOrThrow({
    where: { id: prospectId },
    include: { property: true },
  })

  const issued = await issueToken('PROSPECT_PRESCREEN', {
    type: 'Prospect',
    id: prospect.id,
  })

  await notify({
    category: 'prospect_prescreening',
    templateKey: 'prospect.prescreen_invite',
    recipient: {
      type: 'PROSPECT',
      id: prospect.id,
      email: prospect.email,
      phone: prospect.phone,
    },
    context: {
      firstName: prospect.firstName,
      addressLine1: prospect.property.addressLine1,
      url: authUrl(`/prescreen/${issued.token}`),
    },
    propertyId: prospect.propertyId,
    // Idempotent per prospect - a resend deliberately reuses this key so a
    // double-click cannot fan out two invites for the same inquiry.
    idempotencyKey: `prospect-prescreen:${prospect.id}`,
  })

  await prisma.prospect.update({
    where: { id: prospect.id },
    data: { preScreenSentAt: new Date() },
  })
}
