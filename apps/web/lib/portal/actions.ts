'use server'

import { validateOutboundMessage } from '@rental/core/comms'
import { prisma } from '@rental/db'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { auth, signOut } from '@/auth.ts'
import { requireTenantWithScope } from './guard.ts'

// Writes a tenant can make from the portal (R-018).

export async function signOutTenant() {
  await revokeOwnPortalSessions()
  await signOut({ redirectTo: '/portal/login' })
}

/// R-165. Same NextAuth signOut, different landing page - it does not matter
/// which portal a session came from, only where it should go back to.
export async function signOutGuarantor() {
  await revokeOwnPortalSessions()
  await signOut({ redirectTo: '/portal/guarantor/login' })
}

/// K1 (INV-05). A bare `signOut()` only clears THIS browser's cookie; the JWT
/// itself stays valid until it expires, so a copy of it (a shared computer, a
/// leaked cookie) kept working after the renter pressed "Sign out". Bumping
/// the `sessionsValidFrom` watermark is what makes the jwt callback refuse
/// it, exactly as staff sign-out (`signOutEverywhere`) already does. It also
/// ends the renter's other devices - the same trade staff sign-out makes.
///
/// Keyed on the SESSION's own id and kind, never on anything the form sent,
/// and scoped to the session's org. No session (already signed out) is a
/// no-op rather than an error.
async function revokeOwnPortalSessions(): Promise<void> {
  const principal = (await auth())?.principal
  if (!principal?.id) return
  const where = { id: principal.id, orgId: principal.orgId }
  const data = { sessionsValidFrom: new Date() }
  if (principal.kind === 'guarantor') await prisma.guarantor.updateMany({ where, data })
  else if (principal.kind === 'tenant') await prisma.tenant.updateMany({ where, data })
}

export interface FormState {
  error?: string
  fieldErrors?: Record<string, string>
}

/**
 * A tenant's reply in their own conversation (COMM-01).
 *
 * The thread is looked up BY the tenant's own id, not merely checked against
 * it - `findFirst({ where: { id, tenantId } })` cannot return somebody else's
 * thread, whereas load-then-compare has a shape where the comparison can be
 * forgotten or inverted. Same reasoning as the queries in this module.
 *
 * Recorded as INBOUND: direction is written from the landlord's side
 * throughout this product, and a message from the tenant arrives at the
 * landlord. Nothing is transmitted - the staff inbox reads it directly, which
 * is what makes PORTAL a real channel rather than a label.
 */
export async function replyFromPortal(
  threadId: string,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const { tenant, scope } = await requireTenantWithScope({ write: true })

  const thread = await prisma.thread.findFirst({
    where: { id: threadId, tenantId: scope.tenantId },
    select: { id: true },
  })
  if (!thread) {
    // Indistinguishable from a thread that does not exist - see the queries.
    return { error: 'That conversation could not be found.' }
  }

  const body = formData.get('body')
  const text = typeof body === 'string' ? body.trim() : ''

  const violations = validateOutboundMessage({
    threadId,
    channel: 'PORTAL',
    body: text,
  })
  if (violations.length > 0) {
    return {
      error: 'Please write a message first.',
      fieldErrors: Object.fromEntries(
        violations.map((v) => [v.field, v.message]),
      ),
    }
  }

  const sentAt = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.message.create({
      data: {
        threadId,
        channel: 'PORTAL',
        direction: 'INBOUND',
        body: text,
        sentAt,
        tenantId: tenant.id,
        delivery: { create: { status: 'DELIVERED', deliveredAt: sentAt } },
      },
    })
    await tx.thread.update({
      where: { id: threadId },
      data: { lastMessageAt: sentAt },
    })
  })

  revalidatePath(`/portal/messages/${threadId}`)
  redirect(`/portal/messages/${threadId}`)
}
