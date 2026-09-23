import 'server-only'

import { prisma } from '@rental/db'
import { authUrl } from '@/lib/auth/delivery.ts'
import { issueToken } from '@/lib/auth/store.ts'
import { notify } from '@/lib/notifications/send.ts'

// NOT a 'use server' module, on purpose (SEC-01) - see prospects/invite.ts.

/**
 * Mints a single-use SHOWING_BOOKING token and sends the invite. Called from
 * `prospects/prescreen-actions.ts` right after a prospect answers, so
 * booking stays fully self-serve end to end - see that file's own call
 * site. Best-effort like `sendPrescreenInvite`: the Prospect row and its
 * PRE_SCREENED status survive even when this fails.
 */
export async function sendShowingInvite(prospectId: string): Promise<void> {
  const prospect = await prisma.prospect.findUniqueOrThrow({
    where: { id: prospectId },
    include: { property: true },
  })

  const issued = await issueToken('SHOWING_BOOKING', { type: 'Prospect', id: prospect.id })

  await notify({
    category: 'prospect_showing',
    templateKey: 'showing.invite',
    recipient: {
      type: 'PROSPECT',
      id: prospect.id,
      email: prospect.email,
      phone: prospect.phone,
    },
    context: {
      firstName: prospect.firstName,
      addressLine1: prospect.property.addressLine1,
      url: authUrl(`/showings/${issued.token}`),
    },
    propertyId: prospect.propertyId,
    // Idempotent per prospect - a resend deliberately reuses this key so a
    // double-click cannot fan out two invites, matching
    // sendPrescreenInvite's own reasoning.
    idempotencyKey: `prospect-showing-invite:${prospect.id}`,
  })
}
